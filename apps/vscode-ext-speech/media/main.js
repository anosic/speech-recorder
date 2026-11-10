//@ts-check
// Runs inside the webview. All state is owned by the extension host; this script renders it and forwards clicks.
(function () {
	const vscode = acquireVsCodeApi();
	const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
	const record = $('record'), stop = $('stop'), status = $('status'), transcript = $('transcript'), copy = $('copy'),
		file = $('transcribeFile'), clear = $('clear'), meter = $('meter'), bar = $('meterBar');

	record.addEventListener('click', () => vscode.postMessage({ type: 'record' }));
	stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
	file.addEventListener('click', () => vscode.postMessage({ type: 'transcribeFile' }));
	copy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
	clear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			const s = msg.state;
			record.disabled = s.recording || s.busy;
			stop.disabled = !s.recording;
			file.disabled = s.recording || s.busy;
			meter.classList.toggle('active', s.recording);
			if (!s.recording) { bar.style.width = '0%'; }
			status.textContent = s.status;
			if (transcript.value !== s.transcript) { transcript.value = s.transcript; }
			copy.disabled = !s.transcript;
			clear.disabled = !s.transcript || s.recording || s.busy;
			copy.textContent = s.copied ? 'Copied!' : 'Copy';
			copy.classList.toggle('copied', s.copied);
		} else if (msg.type === 'level') {
			// Map RMS to 0..100% on a -60..0 dBFS scale.
			const db = 20 * Math.log10(Math.max(msg.rms, 1e-6));
			bar.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100)).toFixed(0)}%`;
			const t = Math.floor(msg.elapsed);
			status.textContent = `Recording ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}  (${db.toFixed(0)} dBFS)`;
		}
	});

	vscode.postMessage({ type: 'ready' });
}());
