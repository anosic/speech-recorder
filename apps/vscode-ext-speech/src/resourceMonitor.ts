import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';

export type ResourceLevel = 'ok' | 'degraded' | 'severe';

export interface ResourceHealth {
	level: ResourceLevel;
	summary: string;
}

export interface ResourceMonitorConfig {
	enabled: boolean;
	intervalMs: number;
	cpuLoadDegradedRatio: number;
	cpuLoadSevereRatio: number;
	ramUsedDegradedPercent: number;
	ramUsedSeverePercent: number;
	swapDegradedMBps: number;
	swapSevereMBps: number;
}

export const DEFAULT_RESOURCE_CONFIG: ResourceMonitorConfig = {
	enabled: false,
	intervalMs: 5_000,
	cpuLoadDegradedRatio: 0.8,
	cpuLoadSevereRatio: 1.1,
	ramUsedDegradedPercent: 85,
	ramUsedSeverePercent: 92,
	swapDegradedMBps: 1,
	swapSevereMBps: 10,
};

const PAGE_BYTES = 4096;
const BYTES_PER_MIB = 1_048_576;
/** Number of recent samples averaged to smooth out brief I/O or allocation spikes. */
const SMOOTH_WINDOW = 3;
/** Consecutive elevated samples required before escalating from 'ok' (e.g. 2 × 5s = 10s). */
const ESCALATE_STREAK = 2;
/** Consecutive 'ok' samples required before clearing an active warning (e.g. 3 × 5s = 15s). */
const RECOVER_STREAK = 3;

interface SwapSample {
	pages: number;
	atMs: number;
}

/**
 * Periodically checks CPU load, available memory, and (on Linux) swap thrashing rate
 * so the status bar can warn when local Whisper transcription is likely to be slow.
 * Uses a rolling average and hysteresis so brief spikes don't flicker the indicator.
 */
export class ResourceMonitor implements vscode.Disposable {
	private timer?: NodeJS.Timeout;
	private lastSwap?: SwapSample;
	private swapHistory: number[] = [];
	private memHistory: number[] = [];
	private escalateCount = 0;
	private recoverCount = 0;
	private disposed = false;
	private config: ResourceMonitorConfig;
	private lastHealth: ResourceHealth = { level: 'ok', summary: '' };

	constructor(
		private readonly onUpdate: (health: ResourceHealth) => void,
		config: ResourceMonitorConfig = DEFAULT_RESOURCE_CONFIG,
	) {
		this.config = config;
		this.restart();
	}

	get current(): ResourceHealth {
		return this.lastHealth;
	}

	configure(config: ResourceMonitorConfig): void {
		if (this.disposed) { return; }
		const intervalChanged = config.intervalMs !== this.config.intervalMs || config.enabled !== this.config.enabled;
		this.config = config;
		if (!config.enabled) {
			clearInterval(this.timer);
			this.timer = undefined;
			this.resetState();
			if (this.lastHealth.level !== 'ok' || this.lastHealth.summary !== '') {
				this.lastHealth = { level: 'ok', summary: '' };
				this.onUpdate(this.lastHealth);
			}
			return;
		}
		if (intervalChanged) {
			this.restart();
		} else {
			void this.sample();
		}
	}

	private restart(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		if (!this.config.enabled || this.disposed) { return; }
		void this.sample();
		this.timer = setInterval(() => { void this.sample(); }, this.config.intervalMs);
	}

	private resetState(): void {
		this.lastSwap = undefined;
		this.swapHistory = [];
		this.memHistory = [];
		this.escalateCount = 0;
		this.recoverCount = 0;
	}

	private async sample(): Promise<void> {
		if (this.disposed || !this.config.enabled) { return; }
		try {
			const raw = await this.measure();
			if (this.disposed || !this.config.enabled) { return; }

			const nextLevel = this.applyHysteresis(raw.level);
			const nextHealth: ResourceHealth = { level: nextLevel, summary: raw.summary };

			if (nextHealth.level !== this.lastHealth.level || nextHealth.summary !== this.lastHealth.summary) {
				this.lastHealth = nextHealth;
				this.onUpdate(nextHealth);
			}
		} catch {
			// Best-effort telemetry; never disrupt extension operation.
		}
	}

	private applyHysteresis(rawLevel: ResourceLevel): ResourceLevel {
		if (rawLevel === 'ok') {
			this.escalateCount = 0;
			if (this.lastHealth.level === 'ok') {
				this.recoverCount = 0;
				return 'ok';
			}
			this.recoverCount++;
			return this.recoverCount >= RECOVER_STREAK ? 'ok' : this.lastHealth.level;
		}

		this.recoverCount = 0;
		if (this.lastHealth.level === 'ok') {
			this.escalateCount++;
			return this.escalateCount >= ESCALATE_STREAK ? rawLevel : 'ok';
		}
		return rawLevel;
	}

	private async measure(): Promise<ResourceHealth> {
		const cpus = Math.max(1, os.cpus().length);
		const load1 = os.loadavg()[0] ?? 0;
		const loadRatio = load1 / cpus;

		const { memAvailableRatio } = await readMemoryStats();
		const memAvgRatio = pushAvg(this.memHistory, memAvailableRatio, SMOOTH_WINDOW);
		const memUsedPct = Math.round((1 - memAvgRatio) * 100);

		const swapInstant = await this.readSwapRate();
		const swapMBps = pushAvg(this.swapHistory, swapInstant, SMOOTH_WINDOW) / BYTES_PER_MIB;

		const {
			cpuLoadDegradedRatio, cpuLoadSevereRatio,
			ramUsedDegradedPercent, ramUsedSeverePercent,
			swapDegradedMBps, swapSevereMBps,
		} = this.config;

		const reasons: string[] = [];
		let level: ResourceLevel = 'ok';

		if (swapMBps >= swapSevereMBps) {
			level = 'severe';
		} else if (swapMBps >= swapDegradedMBps) {
			level = maxLevel(level, 'degraded');
		}
		if (swapMBps >= swapDegradedMBps) {
			reasons.push(`Swap ${swapMBps.toFixed(1)} MB/s`);
		}

		if (memUsedPct >= ramUsedSeverePercent) {
			level = 'severe';
		} else if (memUsedPct >= ramUsedDegradedPercent) {
			level = maxLevel(level, 'degraded');
		}
		if (memUsedPct >= ramUsedDegradedPercent) {
			reasons.push(`RAM ${memUsedPct}% used`);
		}

		if (loadRatio >= cpuLoadSevereRatio) {
			level = 'severe';
		} else if (loadRatio >= cpuLoadDegradedRatio) {
			level = maxLevel(level, 'degraded');
		}
		if (loadRatio >= cpuLoadDegradedRatio) {
			reasons.push(`CPU load ${load1.toFixed(1)}/${cpus}`);
		}

		const summary = reasons.length > 0
			? reasons.join(' · ')
			: `CPU ${load1.toFixed(1)}/${cpus} · RAM ${memUsedPct}% used`;

		return { level, summary };
	}

	private async readSwapRate(): Promise<number> {
		if (process.platform !== 'linux') { return 0; }
		try {
			const raw = await fs.readFile('/proc/vmstat', 'utf8');
			const pswpin = matchProcValue(raw, 'pswpin');
			const pswpout = matchProcValue(raw, 'pswpout');
			if (pswpin === undefined || pswpout === undefined) { return 0; }
			const pages = pswpin + pswpout;
			const now = Date.now();
			const prev = this.lastSwap;
			this.lastSwap = { pages, atMs: now };
			if (!prev || now <= prev.atMs) { return 0; }
			const dtSec = (now - prev.atMs) / 1000;
			return Math.max(0, (pages - prev.pages) / dtSec) * PAGE_BYTES;
		} catch {
			return 0;
		}
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

function pushAvg(history: number[], value: number, maxLen: number): number {
	history.push(value);
	if (history.length > maxLen) { history.shift(); }
	return history.reduce((sum, v) => sum + v, 0) / history.length;
}

async function readMemoryStats(): Promise<{ memAvailableRatio: number }> {
	if (process.platform === 'linux') {
		try {
			const raw = await fs.readFile('/proc/meminfo', 'utf8');
			const totalKb = matchProcValue(raw, 'MemTotal:');
			const availKb = matchProcValue(raw, 'MemAvailable:');
			if (totalKb && availKb !== undefined) {
				return { memAvailableRatio: availKb / totalKb };
			}
		} catch {
			// Fall back to os.freemem below.
		}
	}
	const total = os.totalmem();
	const free = os.freemem();
	return { memAvailableRatio: total > 0 ? free / total : 1 };
}

function matchProcValue(content: string, key: string): number | undefined {
	const match = content.match(new RegExp(`^${key}\\s+(\\d+)`, 'm'));
	return match ? Number(match[1]) : undefined;
}

function maxLevel(a: ResourceLevel, b: ResourceLevel): ResourceLevel {
	const rank: Record<ResourceLevel, number> = { ok: 0, degraded: 1, severe: 2 };
	return rank[a] >= rank[b] ? a : b;
}
