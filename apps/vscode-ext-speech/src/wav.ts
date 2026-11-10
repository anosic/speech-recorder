/** Minimal WAV reader: PCM 16/32-bit int or 32-bit float, any channel count, resampled to 16 kHz mono. */
export function readWav(buf: Buffer, targetRate = 16000): Float32Array {
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('not a RIFF/WAVE file');
	}
	let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
	let data: Buffer | undefined;
	for (let off = 12; off + 8 <= buf.length;) {
		const id = buf.toString('ascii', off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		const body = buf.subarray(off + 8, off + 8 + size);
		if (id === 'fmt ') {
			fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
		} else if (id === 'data') {
			data = body;
		}
		off += 8 + size + (size & 1);
	}
	if (!fmt || !data) { throw new Error('missing fmt or data chunk'); }
	const isFloat = fmt.format === 3;
	const bytes = fmt.bits / 8;
	const frames = Math.floor(data.length / (bytes * fmt.channels));
	const mono = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		let sum = 0;
		for (let c = 0; c < fmt.channels; c++) {
			const p = (i * fmt.channels + c) * bytes;
			if (isFloat) { sum += data.readFloatLE(p); }
			else if (fmt.bits === 16) { sum += data.readInt16LE(p) / 32768; }
			else if (fmt.bits === 32) { sum += data.readInt32LE(p) / 2147483648; }
			else { throw new Error(`unsupported bit depth ${fmt.bits}`); }
		}
		mono[i] = sum / fmt.channels;
	}
	return fmt.rate === targetRate ? mono : resampleLinear(mono, fmt.rate, targetRate);
}

function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
	const out = new Float32Array(Math.floor(x.length * to / from));
	const step = from / to;
	for (let i = 0; i < out.length; i++) {
		const t = i * step, j = Math.floor(t), f = t - j;
		out[i] = x[j] * (1 - f) + (x[Math.min(j + 1, x.length - 1)] * f);
	}
	return out;
}
