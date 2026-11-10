// Benchmark: node out/bench.js <file.wav> [--model id] [--dtype q8] [--cache dir] [--runs 3]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWav } from './wav';
import { Transcriber } from './stt';

function arg(name: string, def: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : def;
}

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0);

async function main() {
	const wavPath = process.argv[2];
	if (!wavPath || wavPath.startsWith('--')) { throw new Error('usage: bench.js <file.wav> [--model id] [--dtype q8] [--cache dir] [--runs n]'); }
	const model = arg('model', 'onnx-community/whisper-small');
	const dtype = arg('dtype', 'q8');
	const cacheDir = resolve(arg('cache', resolve(__dirname, '../../../models/onnx-cache')));
	const runs = Number(arg('runs', '3'));

	const audio = readWav(readFileSync(wavPath));
	const secs = audio.length / 16000;
	console.log(`audio: ${wavPath} (${secs.toFixed(2)} s)  model: ${model}  dtype: ${dtype}  cache: ${cacheDir}`);

	let t0 = process.hrtime.bigint();
	const stt = await Transcriber.load({ model, dtype, cacheDir });
	console.log(`load: ${ms(t0).toFixed(0)} ms  rss: ${mb()} MB`);

	const bench = async (label: string, samples: Float32Array) => {
		const dur = samples.length / 16000;
		const times: number[] = [];
		let text = '';
		for (let i = 0; i < runs; i++) {
			t0 = process.hrtime.bigint();
			text = (await stt.transcribe(samples)).text;
			times.push(ms(t0));
		}
		const warm = times.length > 1 ? times.slice(1) : times;
		const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
		console.log(`${label}: ${dur.toFixed(2)} s audio  first ${times[0].toFixed(0)} ms  warm mean ${mean.toFixed(0)} ms  RTF ${(mean / 1000 / dur).toFixed(3)}  rss ${mb()} MB`);
		console.log(`  text: ${text.trim()}`);
	};

	await bench('full clip', audio);
	await bench('3 s chunk', audio.subarray(0, 3 * 16000));
	await stt.dispose();
}

main().catch(err => { console.error(err); process.exit(1); });
