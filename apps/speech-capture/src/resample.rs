//! Streaming mono resampler to 16 kHz: windowed-sinc low-pass (anti-alias) followed by linear interpolation, with
//! filter history and interpolation phase carried across chunks so chunk boundaries are seamless.

pub const TARGET_RATE: u32 = 16_000;

pub struct Resampler {
    /// Source samples advanced per output sample.
    step: f64,
    fir: Vec<f32>,
    /// Last `fir.len() - 1` unfiltered samples from the previous chunk.
    history: Vec<f32>,
    /// Filtered samples not yet fully consumed by interpolation.
    pending: Vec<f32>,
    /// Fractional read position into `pending`.
    pos: f64,
}

impl Resampler {
    pub fn new(src_rate: u32) -> Self {
        let step = src_rate as f64 / TARGET_RATE as f64;
        let fir = if src_rate > TARGET_RATE { low_pass(src_rate, 7_200.0, 63) } else { vec![1.0] };
        let history = vec![0.0; fir.len() - 1];
        Self { step, fir, history, pending: Vec::new(), pos: 0.0 }
    }

    /// Feed mono samples at the source rate; returns 16 kHz samples.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.step == 1.0 {
            return input.to_vec();
        }
        let taps = self.fir.len();
        let mut window = std::mem::take(&mut self.history);
        window.extend_from_slice(input);
        for i in 0..input.len() {
            let acc: f32 = self.fir.iter().zip(&window[i..i + taps]).map(|(c, x)| c * x).sum();
            self.pending.push(acc);
        }
        self.history = window[window.len() - (taps - 1)..].to_vec();

        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        while self.pos + 1.0 < self.pending.len() as f64 {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            out.push(self.pending[i] * (1.0 - f) + self.pending[i + 1] * f);
            self.pos += self.step;
        }
        let consumed = (self.pos as usize).min(self.pending.len());
        self.pending.drain(..consumed);
        self.pos -= consumed as f64;
        out
    }

    /// Push zeros through the filter delay so the tail of the input is emitted.
    pub fn flush(&mut self) -> Vec<f32> {
        if self.step == 1.0 {
            return Vec::new();
        }
        let delay = vec![0.0; self.fir.len() / 2 + 1];
        self.process(&delay)
    }
}

/// Blackman-windowed sinc low-pass, normalised to unity DC gain.
fn low_pass(rate: u32, cutoff_hz: f64, taps: usize) -> Vec<f32> {
    let fc = cutoff_hz / rate as f64;
    let m = (taps - 1) as f64;
    let mut h: Vec<f64> = (0..taps)
        .map(|n| {
            let x = n as f64 - m / 2.0;
            let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / m).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * n as f64 / m).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = h.iter().sum();
    h.iter_mut().for_each(|v| *v /= sum);
    h.into_iter().map(|v| v as f32).collect()
}

/// Average interleaved channels to mono.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f64, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize)
            .map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin() as f32 * 0.5)
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn chunked_equals_whole() {
        let input = tone(48_000, 440.0, 1.0);
        let whole = { let mut r = Resampler::new(48_000); let mut o = r.process(&input); o.extend(r.flush()); o };
        let mut r = Resampler::new(48_000);
        let mut chunked = Vec::new();
        for c in input.chunks(479) {
            chunked.extend(r.process(c));
        }
        chunked.extend(r.flush());
        assert_eq!(whole.len(), chunked.len());
        for (a, b) in whole.iter().zip(&chunked) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    #[test]
    fn length_matches_ratio() {
        for rate in [44_100u32, 48_000, 32_000] {
            let mut r = Resampler::new(rate);
            let mut out = r.process(&vec![0.1; rate as usize * 2]);
            out.extend(r.flush());
            let expected = TARGET_RATE as i64 * 2;
            assert!((out.len() as i64 - expected).abs() <= 40, "rate {rate}: {} vs {expected}", out.len());
        }
    }

    #[test]
    fn passes_speech_band_and_rejects_alias() {
        let mut r = Resampler::new(48_000);
        let pass = r.process(&tone(48_000, 1_000.0, 0.5));
        assert!((rms(&pass[400..]) - 0.354).abs() < 0.02, "1 kHz rms {}", rms(&pass[400..]));
        let mut r = Resampler::new(48_000);
        // 12 kHz would alias to 4 kHz under plain linear interpolation.
        let stop = r.process(&tone(48_000, 12_000.0, 0.5));
        assert!(rms(&stop[400..]) < 0.01, "12 kHz leak rms {}", rms(&stop[400..]));
    }

    #[test]
    fn passthrough_at_16k() {
        let mut r = Resampler::new(16_000);
        assert_eq!(r.process(&[0.1, 0.2, 0.3]), vec![0.1, 0.2, 0.3]);
        assert!(r.flush().is_empty());
    }

    #[test]
    fn downmix_stereo() {
        assert_eq!(downmix(&[0.2, 0.4, -1.0, 1.0], 2), vec![0.3f32, 0.0]);
    }
}
