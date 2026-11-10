import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export type CaptureEvent =
	| { event: 'ready'; device: string; host: string; rate: number; channels: number; format: string; ns: boolean; agc: boolean }
	| { event: 'level'; rms: number; peak: number }
	| { event: 'error'; message: string }
	| { event: 'stopped'; samples: number; seconds: number };

export interface CaptureOptions {
	binary: string;
	device?: string;
	ns?: boolean;
	agc?: boolean;
}

/**
 * Locate the speech-capture binary: explicit setting; else `bin/` inside a packaged (VSIX) install; else, when running
 * from the source tree, the Cargo target dir two levels up (release, then debug).
 */
export function resolveCaptureBinary(setting: string, extensionPath: string): string | undefined {
	if (setting) { return existsSync(setting) ? setting : undefined; }
	const exe = process.platform === 'win32' ? 'speech-capture.exe' : 'speech-capture';
	const root = realpathSync(extensionPath);
	return [join(root, 'bin', exe), ...['release', 'debug'].map(profile => join(root, '..', '..', 'target', profile, exe))]
		.find(p => existsSync(p));
}

/** One recording: spawn on construction, collect 16 kHz mono f32le from stdout, `stop()` closes stdin and resolves the samples. */
export class CaptureSession {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly chunks: Buffer[] = [];
	private readonly exited: Promise<number | null>;
	private stderrTail = '';
	private lastError?: string;

	constructor(opts: CaptureOptions, private readonly onEvent: (e: CaptureEvent) => void, private readonly log: (line: string) => void) {
		const args: string[] = [];
		if (opts.device) { args.push('--device', opts.device); }
		if (opts.ns) { args.push('--ns'); }
		if (opts.agc) { args.push('--agc'); }
		log(`spawn ${opts.binary} ${args.join(' ')}`);
		this.child = spawn(opts.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdout.on('data', (b: Buffer) => this.chunks.push(b));
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (s: string) => this.onStderr(s));
		this.exited = new Promise(resolve => {
			this.child.on('error', err => { this.lastError = err.message; log(`capture process error: ${err.message}`); resolve(null); });
			this.child.on('close', code => resolve(code));
		});
	}

	/** Close stdin (the stop signal), wait for the flush and exit, and return the captured samples. */
	async stop(): Promise<Float32Array> {
		this.child.stdin.end();
		const timer = setTimeout(() => this.child.kill(), 5000);
		const code = await this.exited;
		clearTimeout(timer);
		if (code !== 0) {
			throw new Error(this.lastError ?? `speech-capture exited with code ${code}`);
		}
		const all = Buffer.concat(this.chunks);
		// Copy into a fresh, 4-byte-aligned buffer (Buffer.concat may return a pooled slice at any offset).
		const samples = new Float32Array(Math.floor(all.length / 4));
		new Uint8Array(samples.buffer).set(all.subarray(0, samples.length * 4));
		return samples;
	}

	kill(): void {
		this.child.kill();
	}

	private onStderr(s: string) {
		this.stderrTail += s;
		const lines = this.stderrTail.split('\n');
		this.stderrTail = lines.pop() ?? '';
		for (const line of lines) {
			const t = line.trim();
			if (!t) { continue; }
			if (t.startsWith('{')) {
				try {
					const e = JSON.parse(t) as CaptureEvent;
					if (e.event === 'error') { this.lastError = e.message; }
					if (e.event !== 'level') { this.log(`capture: ${t}`); }
					this.onEvent(e);
					continue;
				} catch { /* fall through to raw log */ }
			}
			this.log(`capture stderr: ${t}`);
		}
	}
}
