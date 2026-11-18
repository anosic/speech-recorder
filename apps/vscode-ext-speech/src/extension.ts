import * as vscode from 'vscode';
import { readWav } from './wav';
import { SttClient } from './sttClient';
import type { SttOptions } from './stt';
import { CaptureSession, resolveCaptureBinary } from './capture';
import { DEFAULT_SHORTCUT, StatusIndicator, type Phase } from './statusIndicator';
import { DEFAULT_RESOURCE_CONFIG, ResourceMonitor, type ResourceMonitorConfig } from './resourceMonitor';
import { resolveModel } from './models';

/** Recordings quieter than this (RMS) are treated as silence and not transcribed. */
const SILENCE_DBFS = -70;
/** When an auto-clear comes due mid-recording or mid-transcription, try again this much later. */
const AUTO_CLEAR_RETRY_MS = 10_000;
/** How often to re-check whether the clipboard still matches the transcript (only while there is one). */
const CLIPBOARD_POLL_MS = 1500;

export function activate(context: vscode.ExtensionContext) {
	const out = vscode.window.createOutputChannel('Anosic Speech Recorder');
	const log = (line: string) => out.appendLine(`[${new Date().toISOString()}] ${line}`);
	const stt = new SttClient(log);
	const indicator = new StatusIndicator();
	const provider = new RecorderViewProvider(context.extensionUri, {
		record: () => startRecording(),
		stop: () => void stopRecording(),
		copy: () => void copyTranscript(),
		clear: () => void clearTranscript(),
		syncClipboard: () => void syncCopied(),
	}, state => indicator.render(state));
	let session: CaptureSession | undefined;
	let busy = false; // stopping or transcribing
	let startedAt = 0;

	const config = () => vscode.workspace.getConfiguration('anosicSpeech');
	const resourceConfig = (): ResourceMonitorConfig => {
		const cfg = config();
		const intervalSec = Math.max(1, cfg.get<number>('resourceMonitor.intervalSeconds', DEFAULT_RESOURCE_CONFIG.intervalMs / 1000));
		return {
			enabled: cfg.get<boolean>('resourceMonitor.enabled', DEFAULT_RESOURCE_CONFIG.enabled),
			intervalMs: intervalSec * 1000,
			cpuLoadDegradedRatio: cfg.get<number>('resourceMonitor.cpuLoadDegradedRatio', DEFAULT_RESOURCE_CONFIG.cpuLoadDegradedRatio),
			cpuLoadSevereRatio: cfg.get<number>('resourceMonitor.cpuLoadSevereRatio', DEFAULT_RESOURCE_CONFIG.cpuLoadSevereRatio),
			ramUsedDegradedPercent: cfg.get<number>('resourceMonitor.ramUsedDegradedPercent', DEFAULT_RESOURCE_CONFIG.ramUsedDegradedPercent),
			ramUsedSeverePercent: cfg.get<number>('resourceMonitor.ramUsedSeverePercent', DEFAULT_RESOURCE_CONFIG.ramUsedSeverePercent),
			swapDegradedMBps: cfg.get<number>('resourceMonitor.swapDegradedMBps', DEFAULT_RESOURCE_CONFIG.swapDegradedMBps),
			swapSevereMBps: cfg.get<number>('resourceMonitor.swapSevereMBps', DEFAULT_RESOURCE_CONFIG.swapSevereMBps),
		};
	};
	const monitor = new ResourceMonitor(health => indicator.setResourceHealth(health), resourceConfig());
	const sttOptions = (): SttOptions => {
		const cfg = config();
		const { model, dtype, revision } = resolveModel((key, fallback) => cfg.get(key, fallback));
		return {
			model,
			dtype,
			revision,
			cacheDir: cfg.get<string>('modelCacheDir') || vscode.Uri.joinPath(context.globalStorageUri, 'models').fsPath,
		};
	};

	const fail = (err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		log(`error: ${err instanceof Error ? (err.stack ?? msg) : msg}`);
		provider.update({ phase: 'error', status: 'Error (see Output › Anosic Speech Recorder)' });
		vscode.window.showErrorMessage(`Anosic Speech Recorder: ${msg.split('\n')[0]}`);
		out.show(true);
	};

	/** "Copied!" means the clipboard holds exactly the full transcript. */
	const syncCopied = async () => {
		const text = provider.state.transcript;
		const eol = (t: string) => t.replace(/\r\n/g, '\n'); // the Windows clipboard may convert line endings
		const copied = text !== '' && eol(await vscode.env.clipboard.readText()) === eol(text);
		if (copied !== provider.state.copied) { provider.update({ copied }); }
	};

	const copyTranscript = async () => {
		const text = provider.state.transcript;
		if (!text) { return; }
		await vscode.env.clipboard.writeText(text);
		await syncCopied();
	};

	/** Empty the memo, and the clipboard too if it still holds the transcript (never clobber something copied since). */
	const clearTranscript = async (status = 'Cleared') => {
		if (session || busy) { return; }
		cancelAutoClear();
		transcribedAt = undefined;
		await syncCopied();
		if (provider.state.copied) { await vscode.env.clipboard.writeText(''); }
		provider.update({ phase: 'idle', transcript: '', copied: false, status });
	};

	// Auto-clear (privacy): clear the transcript a set time after the last transcription finished.
	let transcribedAt: number | undefined;
	let doneStatus = '';
	let autoClearTimer: NodeJS.Timeout | undefined;
	const cancelAutoClear = () => {
		clearTimeout(autoClearTimer);
		autoClearTimer = undefined;
		if (provider.state.clearsAt !== undefined) { provider.update({ clearsAt: undefined, clearTotalMs: undefined }); }
	};
	const autoClearMinutes = (): number | undefined => {
		const cfg = config();
		return cfg.get<boolean>('autoClear', true) ? Math.max(1, cfg.get<number>('autoClearTimeoutMinutes', 10)) : undefined;
	};
	const autoClearSuffix = () => {
		const minutes = autoClearMinutes();
		if (minutes === undefined || transcribedAt === undefined) { return ''; }
		const at = new Date(transcribedAt + minutes * 60_000);
		return ` · clears at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
	};
	/** (Re)arm from the last transcription time; called after each transcription and when the settings change. */
	const armAutoClear = () => {
		cancelAutoClear();
		const minutes = autoClearMinutes();
		if (minutes === undefined || transcribedAt === undefined || !provider.state.transcript) { return; }
		const fire = () => {
			if (session || busy) { autoClearTimer = setTimeout(fire, AUTO_CLEAR_RETRY_MS); return; }
			log(`auto-cleared the transcript ${minutes} min after transcription`);
			void clearTranscript(`Cleared automatically after ${minutes} min`);
		};
		const clearsAt = transcribedAt + minutes * 60_000;
		autoClearTimer = setTimeout(fire, Math.max(0, clearsAt - Date.now()));
		provider.update({ clearsAt, clearTotalMs: minutes * 60_000 });
	};

	const transcribe = async (samples: Float32Array, label: string) => {
		const secs = samples.length / 16000;
		if (secs < 0.2) { throw new Error(`no audio captured (${secs.toFixed(2)} s)`); }
		// Whisper invents short phrases ("you", "Thank you.") for silence; don't put those on the clipboard.
		let sumSq = 0;
		for (const v of samples) { sumSq += v * v; }
		const dbfs = 20 * Math.log10(Math.max(Math.sqrt(sumSq / samples.length), 1e-9));
		log(`${label}: level ${dbfs.toFixed(1)} dBFS RMS`);
		if (dbfs < SILENCE_DBFS) {
			provider.update({ phase: 'silence', status: `Silence (${dbfs.toFixed(0)} dBFS): check the microphone${process.env.WSL_DISTRO_NAME ? ' and Windows microphone privacy settings for WSLg' : ''}` });
			return;
		}
		provider.update({ phase: 'transcribing', status: 'Loading model…' });
		const loadMs = await stt.ensureLoaded(sttOptions());
		if (loadMs) { log(`model loaded in ${loadMs.toFixed(0)} ms`); }
		provider.update({ phase: 'transcribing', status: `Transcribing ${secs.toFixed(1)} s…` });
		const { transcript, ms } = await stt.transcribe(samples);
		log(`${label}: ${secs.toFixed(2)} s audio in ${ms.toFixed(0)} ms (RTF ${(ms / 1000 / secs).toFixed(3)})`);
		transcribedAt = Date.now();
		doneStatus = `Done: ${secs.toFixed(1)} s in ${(ms / 1000).toFixed(1)} s`;
		provider.update({ phase: 'done', transcript: transcript.text.trim(), copied: false, status: doneStatus + autoClearSuffix() });
		armAutoClear();
		if (config().get<boolean>('autoCopy', true)) { await copyTranscript(); }
	};

	const startRecording = () => {
		if (session || busy) { return; }
		const cfg = config();
		const binary = resolveCaptureBinary(cfg.get<string>('captureBinary', ''), context.extensionUri.fsPath);
		if (!binary) {
			fail(new Error('speech-capture binary not found. Build it with `cargo build --release -p speech-capture` from the Cargo workspace root, or set anosicSpeech.captureBinary.'));
			return;
		}
		// Warm the model while the user talks.
		stt.ensureLoaded(sttOptions()).catch(err => log(`model preload failed: ${err instanceof Error ? err.message : err}`));
		startedAt = Date.now();
		session = new CaptureSession({
			binary,
			device: cfg.get<string>('inputDevice') || undefined,
			ns: cfg.get<boolean>('noiseSuppression', false),
			agc: cfg.get<boolean>('autoGain', false),
		}, e => {
			if (e.event === 'ready') { provider.update({ status: `Recording from ${e.device} (${e.rate} Hz)` }); }
			else if (e.event === 'level') {
				const elapsed = (Date.now() - startedAt) / 1000;
				provider.level(e.rms, elapsed);
				indicator.tick(elapsed);
			}
		}, log);
		provider.update({ phase: 'recording', recording: true, status: 'Starting capture…' });
	};

	const stopRecording = async () => {
		const s = session;
		if (!s) { return; }
		session = undefined;
		busy = true;
		provider.update({ phase: 'transcribing', recording: false, busy: true, status: 'Stopping…' });
		try {
			await transcribe(await s.stop(), 'recording');
		} catch (err) {
			fail(err);
		} finally {
			busy = false;
			provider.update({ busy: false });
		}
	};

	// Poll whenever there is a transcript: the status bar shows "Copied" even with the panel closed.
	const timer = setInterval(() => { if (provider.state.transcript) { void syncCopied(); } }, CLIPBOARD_POLL_MS);

	context.subscriptions.push(
		{ dispose: () => { clearInterval(timer); cancelAutoClear(); session?.kill(); } },
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('anosicSpeech.resourceMonitor')) {
				monitor.configure(resourceConfig());
			}
			if (!e.affectsConfiguration('anosicSpeech.autoClear') && !e.affectsConfiguration('anosicSpeech.autoClearTimeoutMinutes')) { return; }
			armAutoClear();
			if (provider.state.phase === 'done' && provider.state.transcript) { provider.update({ status: doneStatus + autoClearSuffix() }); }
		}),
		out,
		indicator,
		monitor,
		{ dispose: () => void stt.dispose() },
		vscode.window.onDidChangeWindowState(s => { if (s.focused) { void syncCopied(); } }),
		vscode.window.registerWebviewViewProvider(RecorderViewProvider.viewType, provider),
		vscode.commands.registerCommand('anosicSpeech.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'anosicSpeech')),
		vscode.commands.registerCommand('anosicSpeech.changeShortcut', () =>
			vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@command:anosicSpeech.toggleRecording')),
		vscode.commands.registerCommand('anosicSpeech.toggleRecording', () => {
			if (session) { void stopRecording(); } else { startRecording(); }
		}),
		vscode.commands.registerCommand('anosicSpeech.transcribeFile', async () => {
			if (session || busy) { return; }
			const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'WAV audio': ['wav'] }, title: 'Transcribe WAV file' });
			if (!picked?.[0]) { return; }
			const uri = picked[0];
			busy = true;
			provider.update({ busy: true });
			try {
				const samples = readWav(Buffer.from(await vscode.workspace.fs.readFile(uri)));
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Anosic Speech Recorder: transcribing file' },
					() => transcribe(samples, uri.fsPath));
			} catch (err) {
				fail(err);
			} finally {
				busy = false;
				provider.update({ busy: false });
			}
		}),
	);
}

interface PanelState {
	phase: Phase;
	recording: boolean;
	busy: boolean;
	status: string;
	transcript: string;
	copied: boolean;
	/** Epoch ms when auto-clear will clear the transcript; undefined when no auto-clear is pending. */
	clearsAt?: number;
	/** The full auto-clear delay, for drawing how much of it is left. */
	clearTotalMs?: number;
}

/**
 * The sidebar view. State lives here in the extension host, not in the webview, so the keyboard toggle works before
 * the panel has ever been opened and the panel shows the current state whenever it is (re)created.
 */
class RecorderViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'anosicSpeech.recorderView';
	private _view?: vscode.WebviewView;
	readonly state: PanelState = { phase: 'idle', recording: false, busy: false, status: 'Idle', transcript: '', copied: false };

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _actions: { record: () => void; stop: () => void; copy: () => void; clear: () => void; syncClipboard: () => void },
		private readonly _onState: (state: PanelState) => void,
	) { }

	get visible(): boolean { return this._view?.visible ?? false; }

	update(patch: Partial<PanelState>) {
		Object.assign(this.state, patch);
		this._onState(this.state);
		this._view?.webview.postMessage({ type: 'state', state: this.state });
	}

	level(rms: number, elapsed: number) { this._view?.webview.postMessage({ type: 'level', rms, elapsed }); }

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		this._view = webviewView;
		const webview = webviewView.webview;
		webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		webview.html = this._getHtml(webview);
		webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this._actions.syncClipboard(); } });
		webviewView.onDidDispose(() => { if (this._view === webviewView) { this._view = undefined; } });

		webview.onDidReceiveMessage(async (msg: { type: string }) => {
			switch (msg.type) {
				case 'ready':
					webview.postMessage({ type: 'state', state: this.state });
					this._actions.syncClipboard();
					break;
				case 'record': this._actions.record(); break;
				case 'stop': this._actions.stop(); break;
				case 'transcribeFile': await vscode.commands.executeCommand('anosicSpeech.transcribeFile'); break;
				case 'copy': this._actions.copy(); break;
				case 'clear': this._actions.clear(); break;
			}
		});
	}

	private _getHtml(webview: vscode.Webview) {
		const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', f));
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${uri('reset.css')}" rel="stylesheet">
	<link href="${uri('vscode.css')}" rel="stylesheet">
	<link href="${uri('main.css')}" rel="stylesheet">
	<title>Anosic Speech Recorder</title>
</head>
<body>
	<div class="controls">
		<button id="record" title="Toggle Recording (${DEFAULT_SHORTCUT} by default)">● Record</button>
		<button id="stop" disabled title="Toggle Recording (${DEFAULT_SHORTCUT} by default)">■ Stop</button>
	</div>
	<div class="controls secondary-row">
		<button id="transcribeFile" class="secondary" title="Transcribe WAV file…">Transcribe WAV…</button>
		<button id="clear" class="secondary" disabled title="Clear the memo, and the clipboard if it still holds the transcript">Clear</button>
	</div>
	<p id="status">Idle</p>
	<div id="meter"><div id="meterBar"></div></div>
	<textarea id="transcript" rows="6" readonly placeholder="Transcript appears here"></textarea>
	<button id="copy" class="secondary">Copy</button>
	<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
	}
}

function getNonce() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
