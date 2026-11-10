import * as vscode from 'vscode';

/** The contributed default for anosicSpeech.toggleRecording. Users can rebind it, and the API cannot read the
 *  effective binding, so text that names the key says "by default". */
export const DEFAULT_SHORTCUT = process.platform === 'darwin' ? 'Cmd+Alt+R' : 'Ctrl+Alt+R';

export type Phase = 'idle' | 'recording' | 'transcribing' | 'done' | 'silence' | 'error';

export interface IndicatorState {
	phase: Phase;
	status: string;
	copied: boolean;
	/** Pending auto-clear: deadline (epoch ms) and the full delay. */
	clearsAt?: number;
	clearTotalMs?: number;
}

/** Quarter pies, full to empty: the share of the auto-clear delay still left. */
const PIES = ['●', '◕', '◑', '◔', '○'];

/** Status bar item: mirrors recording / transcribing / copied state; clicking it toggles recording. */
export class StatusIndicator implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('anosicSpeech.status', vscode.StatusBarAlignment.Right, 100);
	private last?: IndicatorState;
	private elapsed = 0;
	/** Redraws the auto-clear countdown once a second while one is pending. */
	private countdown?: NodeJS.Timeout;

	constructor() {
		this.item.name = 'Anosic Speech Recorder';
		this.item.command = 'anosicSpeech.toggleRecording';
		this.render({ phase: 'idle', status: 'Idle', copied: false });
		this.item.show();
	}

	render(s: IndicatorState) {
		this.last = s;
		if (s.phase !== 'recording') { this.elapsed = 0; }
		if (s.clearsAt !== undefined && !this.countdown) {
			this.countdown = setInterval(() => { if (this.last) { this.render(this.last); } }, 1000);
		} else if (s.clearsAt === undefined && this.countdown) {
			clearInterval(this.countdown);
			this.countdown = undefined;
		}
		const { text, bg } = this.look(s);
		const pending = s.phase === 'done' ? this.clearCountdown(s) : undefined;
		this.item.text = pending ? `${text} ${pending.pie} ${pending.left}` : text;
		this.item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
		const action = s.phase === 'recording' ? `Click or press the Toggle Recording shortcut (${DEFAULT_SHORTCUT} by default) to stop and transcribe`
			: s.phase === 'transcribing' ? 'Busy transcribing; click again when it finishes'
				: `Click or press the Toggle Recording shortcut (${DEFAULT_SHORTCUT} by default) to start recording`;
		const clears = pending ? `\nAuto-clear in ${pending.left} (at ${pending.at})` : '';
		this.item.tooltip = `Anosic Speech Recorder: ${s.status}${s.copied ? ' (transcript on clipboard)' : ''}${clears}\n${action}`;
	}

	/** Update the recording clock without a full state change. */
	tick(elapsedSecs: number) {
		this.elapsed = elapsedSecs;
		if (this.last?.phase === 'recording') { this.render(this.last); }
	}

	private look(s: IndicatorState): { text: string; bg?: string } {
		switch (s.phase) {
			case 'recording': {
				const t = Math.floor(this.elapsed);
				return { text: `$(circle-filled) REC ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, bg: 'statusBarItem.errorBackground' };
			}
			case 'transcribing': return { text: `$(loading~spin) ${s.status.replace(/…$/, '')}` };
			case 'silence': return { text: '$(warning) Silence', bg: 'statusBarItem.warningBackground' };
			case 'error': return { text: '$(error) Speech error', bg: 'statusBarItem.errorBackground' };
			case 'done': return { text: s.copied ? '$(mic) $(check) Copied' : '$(mic)' };
			default: return { text: '$(mic)' };
		}
	}

	/** Pie for the share of the delay left, plus the time left: "4m" down to the last minute, then seconds. */
	private clearCountdown(s: IndicatorState): { pie: string; left: string; at: string } | undefined {
		if (s.clearsAt === undefined || !s.clearTotalMs) { return undefined; }
		const leftMs = Math.max(0, s.clearsAt - Date.now());
		const share = leftMs / s.clearTotalMs;
		const pie = PIES[share > 0.875 ? 0 : share > 0.625 ? 1 : share > 0.375 ? 2 : share > 0.125 ? 3 : 4];
		const left = leftMs >= 60_000 ? `${Math.ceil(leftMs / 60_000)}m` : `${Math.ceil(leftMs / 1000)}s`;
		const at = new Date(s.clearsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		return { pie, left, at };
	}

	dispose() {
		clearInterval(this.countdown);
		this.item.dispose();
	}
}
