import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

export interface SttOptions {
	/** Hugging Face model id, e.g. `onnx-community/whisper-small`. */
	model: string;
	/** Weight variant: `q8` (= `*_quantized.onnx`), `int8`, `fp16`, `q4`, `fp32`, … */
	dtype: string;
	/** Directory where downloaded model files are cached. */
	cacheDir: string;
	/** Pinned model revision (commit sha or branch). */
	revision?: string;
	/** Disable network fetches; fail if the model is not already cached. */
	offline?: boolean;
}

export interface Transcript {
	text: string;
	chunks?: { timestamp: [number, number | null]; text: string }[];
}

export class Transcriber {
	private constructor(private readonly asr: AutomaticSpeechRecognitionPipeline) { }

	static async load(opts: SttOptions): Promise<Transcriber> {
		env.cacheDir = opts.cacheDir;
		env.allowRemoteModels = !opts.offline;
		const asr = await pipeline('automatic-speech-recognition', opts.model, {
			device: 'cpu',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			dtype: opts.dtype as any,
			revision: opts.revision,
		});
		return new Transcriber(asr as AutomaticSpeechRecognitionPipeline);
	}

	/** Transcribe 16 kHz mono float samples. */
	async transcribe(samples: Float32Array, timestamps = false): Promise<Transcript> {
		const out = await this.asr(samples, {
			language: 'en',
			task: 'transcribe',
			return_timestamps: timestamps,
			chunk_length_s: samples.length > 30 * 16000 ? 30 : undefined,
		});
		return (Array.isArray(out) ? out[0] : out) as Transcript;
	}

	async dispose(): Promise<void> {
		await this.asr.dispose();
	}
}
