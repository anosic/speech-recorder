//! speech-capture — microphone capture for the Anosic Speech Recorder VS Code extension.
//!
//! Protocol (designed for a parent process, not a terminal):
//! - **stdout**: raw 16 kHz mono PCM, 32-bit float little-endian, nothing else.
//! - **stderr**: one JSON object per line: `ready`, `level` (every 100 ms), `error`, `stopped`.
//! - **stdin**: capture runs until stdin reaches EOF (the parent closes it, or dies). Remaining audio is flushed,
//!   `stopped` is emitted and the process exits 0. Input bytes are ignored.

#[allow(dead_code)]
mod dsp;
mod device;
mod resample;

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use cpal::traits::{DeviceTrait, StreamTrait};

use dsp::{DspConfig, DspProcessor};
use resample::{downmix, Resampler, TARGET_RATE};

const USAGE: &str = "\
speech-capture — 16 kHz mono f32le microphone capture to stdout; JSON-lines events on stderr.

USAGE:
  speech-capture [--device NAME] [--ns] [--agc]
  speech-capture --list-devices

Capture stops when stdin closes.

OPTIONS:
  --device NAME    Input device name (default: pulse under WSLg, else the system default)
  --ns             Noise suppression (sonora)
  --agc            Automatic gain control (sonora)
  --list-devices   Print input device names as a JSON array to stdout and exit
  -h, --help       Show this help
  -V, --version    Show version";

struct Options {
    device: Option<String>,
    ns: bool,
    agc: bool,
    list: bool,
}

fn parse_args() -> Result<Options, String> {
    let mut o = Options { device: None, ns: false, agc: false, list: false };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--device" => o.device = Some(args.next().ok_or("--device needs a value")?),
            "--ns" => o.ns = true,
            "--agc" => o.agc = true,
            "--list-devices" => o.list = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("speech-capture {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}\n\n{USAGE}")),
        }
    }
    Ok(o)
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn event(json: String) {
    let mut err = io::stderr().lock();
    let _ = writeln!(err, "{json}");
    let _ = err.flush();
}

fn error_event(message: &str) {
    event(format!(r#"{{"event":"error","message":{}}}"#, json_str(message)));
}

fn main() {
    let opts = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(opts) {
        error_event(&e);
        std::process::exit(1);
    }
}

fn run(opts: Options) -> Result<(), String> {
    device::setup_wsl_audio_env();
    let host = cpal::default_host();

    if opts.list {
        let names: Vec<String> = device::input_device_names(&host).iter().map(|n| json_str(n)).collect();
        println!("[{}]", names.join(","));
        return Ok(());
    }

    let dev = device::resolve_input_device(&host, opts.device.as_deref())?;
    let name = dev.name().unwrap_or_else(|_| "unknown".into());
    let config = device::select_input_config(&dev)?;
    let rate = config.sample_rate().0;
    let channels = config.channels();

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let stream = build_stream(&dev, &config, tx)?;
    stream.play().map_err(|e| format!("failed to start input stream: {e}"))?;

    // Stop when stdin reaches EOF (or errors): the parent closed it or went away.
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 256];
            let mut stdin = io::stdin().lock();
            while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
            stop.store(true, Ordering::Relaxed);
        });
    }

    event(format!(
        r#"{{"event":"ready","device":{},"host":{},"rate":{rate},"channels":{channels},"format":{},"ns":{},"agc":{}}}"#,
        json_str(&name),
        json_str(&format!("{:?}", host.id())),
        json_str(&format!("{:?}", config.sample_format())),
        opts.ns,
        opts.agc,
    ));

    let mut dsp = DspProcessor::new(rate, channels, DspConfig { noise_suppression: opts.ns, automatic_gain_control: opts.agc });
    let mut resampler = Resampler::new(rate);
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut level = LevelMeter::default();
    let mut total: u64 = 0;

    let mut emit = |samples: Vec<f32>, out: &mut io::BufWriter<io::StdoutLock>, total: &mut u64| -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for s in &samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        out.write_all(&bytes).and_then(|_| out.flush()).map_err(|e| format!("stdout write failed: {e}"))?;
        *total += samples.len() as u64;
        level.feed(&samples);
        Ok(())
    };

    let to_16k = |chunk: &[f32], resampler: &mut Resampler| resampler.process(&downmix(chunk, channels as usize));

    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                let processed = dsp.process(&chunk);
                emit(to_16k(&processed, &mut resampler), &mut out, &mut total)?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("input stream ended unexpectedly".into()),
        }
    }

    // Stop capturing, then drain everything already delivered.
    drop(stream);
    while let Ok(chunk) = rx.try_recv() {
        let processed = dsp.process(&chunk);
        emit(to_16k(&processed, &mut resampler), &mut out, &mut total)?;
    }
    let tail = dsp.flush();
    emit(to_16k(&tail, &mut resampler), &mut out, &mut total)?;
    emit(resampler.flush(), &mut out, &mut total)?;

    event(format!(
        r#"{{"event":"stopped","samples":{total},"seconds":{:.3}}}"#,
        total as f64 / TARGET_RATE as f64
    ));
    Ok(())
}

/// Emits a `level` event (RMS and peak) for every 100 ms of 16 kHz output.
#[derive(Default)]
struct LevelMeter {
    sum_sq: f64,
    peak: f32,
    n: usize,
}

impl LevelMeter {
    fn feed(&mut self, samples: &[f32]) {
        for &s in samples {
            self.sum_sq += (s as f64) * (s as f64);
            self.peak = self.peak.max(s.abs());
            self.n += 1;
            if self.n == (TARGET_RATE / 10) as usize {
                event(format!(r#"{{"event":"level","rms":{:.5},"peak":{:.5}}}"#, (self.sum_sq / self.n as f64).sqrt(), self.peak));
                *self = Self::default();
            }
        }
    }
}

fn build_stream(
    dev: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String> {
    let cfg: cpal::StreamConfig = config.clone().into();
    let err_fn = |e| error_event(&format!("audio input error: {e}"));
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => dev.build_input_stream(&cfg, move |d: &[f32], _| { let _ = tx.send(d.to_vec()); }, err_fn, None),
        cpal::SampleFormat::I16 => dev.build_input_stream(
            &cfg,
            move |d: &[i16], _| { let _ = tx.send(d.iter().map(|&s| s as f32 / 32768.0).collect()); },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => dev.build_input_stream(
            &cfg,
            move |d: &[i32], _| { let _ = tx.send(d.iter().map(|&s| s as f32 / 2_147_483_648.0).collect()); },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => dev.build_input_stream(
            &cfg,
            move |d: &[u16], _| { let _ = tx.send(d.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect()); },
            err_fn,
            None,
        ),
        fmt => return Err(format!("unsupported input sample format: {fmt:?}")),
    };
    stream.map_err(|e| format!("failed to build input stream: {e}"))
}
