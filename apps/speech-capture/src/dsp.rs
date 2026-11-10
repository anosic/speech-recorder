//! Digital Signal Processing (DSP) module wrapping Sonora for noise suppression (NS)
//! and automatic gain control (AGC).

use sonora::config::{GainController2, NoiseSuppression};
use sonora::{AudioProcessing, Config, StreamConfig};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DspConfig {
    pub noise_suppression: bool,
    pub automatic_gain_control: bool,
}

pub struct DspProcessor {
    apm: Option<AudioProcessing>,
    channels: usize,
    frame_size: usize,
    input_accumulator: Vec<f32>,
    in_channels: Vec<Vec<f32>>,
    out_channels: Vec<Vec<f32>>,
    pub ns_enabled: bool,
    pub agc_enabled: bool,
}

impl DspProcessor {
    pub fn new(sample_rate: u32, channels: u16, config: DspConfig) -> Self {
        let channels_usize = channels as usize;
        let stream_config = StreamConfig::new(sample_rate, channels);
        let frame_size = stream_config.num_frames();

        let (apm, ns_enabled, agc_enabled) = if config.noise_suppression || config.automatic_gain_control {
            let sonora_config = Config {
                noise_suppression: if config.noise_suppression {
                    Some(NoiseSuppression::default())
                } else {
                    None
                },
                gain_controller2: if config.automatic_gain_control {
                    Some(GainController2::default())
                } else {
                    None
                },
                ..Default::default()
            };

            let processor = AudioProcessing::builder()
                .config(sonora_config)
                .capture_config(stream_config)
                .render_config(stream_config)
                .build();

            (Some(processor), config.noise_suppression, config.automatic_gain_control)
        } else {
            (None, false, false)
        };

        Self {
            apm,
            channels: channels_usize,
            frame_size,
            input_accumulator: Vec::new(),
            in_channels: vec![vec![0.0f32; frame_size]; channels_usize],
            out_channels: vec![vec![0.0f32; frame_size]; channels_usize],
            ns_enabled,
            agc_enabled,
        }
    }

    /// Whether any DSP feature is actively processing audio.
    #[allow(dead_code)]
    #[inline]
    pub fn is_enabled(&self) -> bool {
        self.apm.is_some()
    }

    /// Human-readable status description for banners and status bars.
    pub fn description(&self) -> String {
        match (self.ns_enabled, self.agc_enabled) {
            (true, true) => "[NS: ON, AGC: ON]".to_string(),
            (true, false) => "[NS: ON, AGC: off]".to_string(),
            (false, true) => "[NS: off, AGC: ON]".to_string(),
            (false, false) => "[Bypass (unprocessed)]".to_string(),
        }
    }

    /// Short badge for the live recording line.
    pub fn badge(&self) -> &'static str {
        match (self.ns_enabled, self.agc_enabled) {
            (true, true) => " [NS+AGC]",
            (true, false) => " [NS]",
            (false, true) => " [AGC]",
            (false, false) => "",
        }
    }

    /// Processes an incoming slice of interleaved audio samples.
    ///
    /// When DSP is bypassed, this returns the chunk directly with zero processing overhead.
    /// When DSP is enabled, samples are accumulated and processed in 10ms Sonora frames.
    pub fn process(&mut self, chunk: &[f32]) -> Vec<f32> {
        let Some(apm) = &mut self.apm else {
            return chunk.to_vec();
        };

        self.input_accumulator.extend_from_slice(chunk);
        let frames_needed = self.frame_size * self.channels;
        let mut output = Vec::with_capacity(chunk.len());

        while self.input_accumulator.len() >= frames_needed {
            // 1. Deinterleave `frame_size` frames into separate channel buffers
            for f in 0..self.frame_size {
                let base = f * self.channels;
                for c in 0..self.channels {
                    self.in_channels[c][f] = self.input_accumulator[base + c];
                }
            }

            // 2. Build channel slice references
            let in_slices: Vec<&[f32]> = self.in_channels.iter().map(|c| c.as_slice()).collect();
            let mut out_slices: Vec<&mut [f32]> =
                self.out_channels.iter_mut().map(|c| c.as_mut_slice()).collect();

            // 3. Process capture frame in Sonora
            if let Err(err) = apm.process_capture_f32(&in_slices, &mut out_slices) {
                eprintln!("\nSonora processing error: {err}");
                // Fallback: copy input channel directly if APM error occurs
                for (out_ch, in_ch) in self.out_channels.iter_mut().zip(self.in_channels.iter()) {
                    out_ch.copy_from_slice(in_ch);
                }
            }

            // 4. Interleave back into output buffer
            for f in 0..self.frame_size {
                for c in 0..self.channels {
                    output.push(self.out_channels[c][f]);
                }
            }

            // 5. Consume processed frames from accumulator
            self.input_accumulator.drain(0..frames_needed);
        }

        output
    }

    /// Flushes any remaining unprocessed samples in the accumulator when recording pauses or stops.
    pub fn flush(&mut self) -> Vec<f32> {
        if self.input_accumulator.is_empty() {
            return Vec::new();
        }
        std::mem::take(&mut self.input_accumulator)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dsp_bypass_preserves_samples() {
        let mut dsp = DspProcessor::new(
            48000,
            2,
            DspConfig {
                noise_suppression: false,
                automatic_gain_control: false,
            },
        );
        assert!(!dsp.is_enabled());
        assert_eq!(dsp.description(), "[Bypass (unprocessed)]");
        assert_eq!(dsp.badge(), "");

        let input = vec![0.1, -0.2, 0.3, -0.4];
        let out = dsp.process(&input);
        assert_eq!(out, input);
        assert!(dsp.flush().is_empty());
    }

    #[test]
    fn test_dsp_ns_and_agc_processing() {
        let mut dsp = DspProcessor::new(
            48000,
            1,
            DspConfig {
                noise_suppression: true,
                automatic_gain_control: true,
            },
        );
        assert!(dsp.is_enabled());
        assert_eq!(dsp.description(), "[NS: ON, AGC: ON]");
        assert_eq!(dsp.badge(), " [NS+AGC]");

        // Feed exactly two 10ms frames (960 samples at 48kHz)
        let input = vec![0.05f32; 960];
        let out = dsp.process(&input);
        assert_eq!(out.len(), 960);
    }
}
