// Runs in a worker_thread so model loading and decoding never block the extension host.
import { parentPort } from 'node:worker_threads';
import { Transcriber, type SttOptions } from './stt';

export type WorkerRequest =
	| { id: number; type: 'load'; opts: SttOptions }
	| { id: number; type: 'transcribe'; samples: Float32Array }
	| { id: number; type: 'dispose' };

export type WorkerResponse =
	| { id: number; ok: true; result?: unknown; ms: number }
	| { id: number; ok: false; error: string };

let stt: Transcriber | undefined;

parentPort!.on('message', async (req: WorkerRequest) => {
	const t0 = performance.now();
	try {
		let result: unknown;
		switch (req.type) {
			case 'load':
				await stt?.dispose();
				stt = await Transcriber.load(req.opts);
				break;
			case 'transcribe':
				if (!stt) { throw new Error('model not loaded'); }
				result = await stt.transcribe(req.samples);
				break;
			case 'dispose':
				await stt?.dispose();
				stt = undefined;
				break;
		}
		parentPort!.postMessage({ id: req.id, ok: true, result, ms: performance.now() - t0 } satisfies WorkerResponse);
	} catch (err) {
		parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) } satisfies WorkerResponse);
	}
});
