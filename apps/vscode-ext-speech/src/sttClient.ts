import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { SttOptions, Transcript } from './stt';
import type { WorkerRequest, WorkerResponse } from './sttWorker';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Extension-host side of the STT worker. Loads the model lazily and keeps it resident. */
export class SttClient {
	private worker?: Worker;
	private nextId = 1;
	private pending = new Map<number, { resolve: (r: { result?: unknown; ms: number }) => void; reject: (e: Error) => void }>();
	private loaded?: Promise<number>;
	private loadedKey?: string;

	constructor(private readonly log: (line: string) => void) { }

	/** Ensures the model is loaded with these options; returns load time in ms (0 if already loaded). */
	ensureLoaded(opts: SttOptions): Promise<number> {
		const key = JSON.stringify(opts);
		if (!this.loaded || this.loadedKey !== key) {
			this.loadedKey = key;
			this.log(`loading ${opts.model} (${opts.dtype}) from ${opts.cacheDir}`);
			this.loaded = this.call({ type: 'load', opts }).then(r => r.ms);
			this.loaded.catch(() => { this.loaded = undefined; });
			return this.loaded;
		}
		return this.loaded.then(() => 0);
	}

	async transcribe(samples: Float32Array): Promise<{ transcript: Transcript; ms: number }> {
		const r = await this.call({ type: 'transcribe', samples }, [samples.buffer as ArrayBuffer]);
		return { transcript: r.result as Transcript, ms: r.ms };
	}

	async dispose(): Promise<void> {
		const w = this.worker;
		this.worker = undefined;
		this.loaded = undefined;
		await w?.terminate();
	}

	private call(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: ArrayBuffer[] = []) {
		const w = this.getWorker();
		const id = this.nextId++;
		return new Promise<{ result?: unknown; ms: number }>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			w.postMessage({ ...req, id }, transfer);
		});
	}

	private getWorker(): Worker {
		if (this.worker) { return this.worker; }
		const w = new Worker(join(__dirname, 'sttWorker.js'));
		w.on('message', (res: WorkerResponse) => {
			const p = this.pending.get(res.id);
			if (!p) { return; }
			this.pending.delete(res.id);
			if (res.ok) { p.resolve({ result: res.result, ms: res.ms }); } else { p.reject(new Error(res.error)); }
		});
		const fail = (err: Error) => {
			this.log(`worker failed: ${err.stack ?? err.message}`);
			for (const p of this.pending.values()) { p.reject(err); }
			this.pending.clear();
			this.worker = undefined;
			this.loaded = undefined;
		};
		w.on('error', fail);
		w.on('exit', code => { if (code !== 0 && this.worker === w) { fail(new Error(`worker exited with code ${code}`)); } });
		this.worker = w;
		return w;
	}
}
