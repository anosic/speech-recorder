//! Input device discovery and stream configuration. Device selection and the WSLg environment fix are copied from
//! the workspace's earlier audio CLI; config selection here prefers a native 16 kHz stream.

use std::path::Path;

use cpal::traits::{DeviceTrait, HostTrait};

/// Configure PULSE_SERVER and repair a missing XDG_RUNTIME_DIR for WSLg; silence ALSA's stderr chatter.
pub fn setup_wsl_audio_env() {
    #[cfg(target_os = "linux")]
    {
        unsafe {
            let handle = libc::dlopen(c"libasound.so.2".as_ptr(), libc::RTLD_LAZY);
            if !handle.is_null() {
                let sym = libc::dlsym(handle, c"snd_lib_error_set_handler".as_ptr());
                if !sym.is_null() {
                    unsafe extern "C" fn silent_alsa(
                        _: *const libc::c_char,
                        _: libc::c_int,
                        _: *const libc::c_char,
                        _: libc::c_int,
                        _: *const libc::c_char,
                    ) {
                    }
                    let set_handler: extern "C" fn(
                        Option<
                            unsafe extern "C" fn(
                                *const libc::c_char,
                                libc::c_int,
                                *const libc::c_char,
                                libc::c_int,
                                *const libc::c_char,
                            ),
                        >,
                    ) -> libc::c_int = std::mem::transmute(sym);
                    set_handler(Some(silent_alsa));
                }
            }
        }

        let needs_xdg_fix = match std::env::var("XDG_RUNTIME_DIR") {
            Ok(dir) => !Path::new(&dir).exists(),
            Err(_) => true,
        };
        if needs_xdg_fix {
            if Path::new("/mnt/wslg/runtime-dir").exists() {
                unsafe { std::env::set_var("XDG_RUNTIME_DIR", "/mnt/wslg/runtime-dir") };
            } else {
                let uid = unsafe { libc::getuid() };
                let fallback = format!("/tmp/runtime-{uid}");
                let _ = std::fs::create_dir_all(&fallback);
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&fallback, std::fs::Permissions::from_mode(0o700));
                }
                unsafe { std::env::set_var("XDG_RUNTIME_DIR", &fallback) };
            }
        }

        if std::env::var("PULSE_SERVER").is_err() {
            for path in ["/mnt/wslg/PulseServer", "/mnt/wslg/runtime-dir/pulse/native"] {
                if Path::new(path).exists() {
                    unsafe { std::env::set_var("PULSE_SERVER", path) };
                    break;
                }
            }
        }
    }
}

pub fn input_device_names(host: &cpal::Host) -> Vec<String> {
    host.input_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

pub fn resolve_input_device(host: &cpal::Host, preferred: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(name) = preferred {
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if d.name().map(|n| n == name).unwrap_or(false) {
                    return Ok(d);
                }
            }
        }
        return Err(format!("Input device '{name}' not found"));
    }
    // In WSL / Pulse environments prefer "pulse" if it works.
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if d.name().map(|n| n == "pulse").unwrap_or(false) && select_input_config(&d).is_ok() {
                return Ok(d);
            }
        }
    }
    if let Some(device) = host.default_input_device() {
        if select_input_config(&device).is_ok() {
            return Ok(device);
        }
    }
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if select_input_config(&d).is_ok() {
                return Ok(d);
            }
        }
    }
    Err("No working audio input device available (in WSL, ensure PulseAudio/WSLg is active)".to_string())
}

const SUPPORTED_FORMATS: [cpal::SampleFormat; 4] =
    [cpal::SampleFormat::F32, cpal::SampleFormat::I16, cpal::SampleFormat::I32, cpal::SampleFormat::U16];

/// Prefer a native 16 kHz config (mono first) so the sound server does the resampling; otherwise use the device
/// default and let our own resampler convert.
pub fn select_input_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    if let Ok(ranges) = device.supported_input_configs() {
        let mut candidates: Vec<_> = ranges
            .filter(|r| {
                r.min_sample_rate().0 <= 16000
                    && r.max_sample_rate().0 >= 16000
                    && SUPPORTED_FORMATS.contains(&r.sample_format())
            })
            .collect();
        candidates.sort_by_key(|r| (r.channels() != 1, r.sample_format() != cpal::SampleFormat::F32, r.channels()));
        if let Some(r) = candidates.into_iter().next() {
            return Ok(r.with_sample_rate(cpal::SampleRate(16000)));
        }
    }
    if let Ok(config) = device.default_input_config() {
        if SUPPORTED_FORMATS.contains(&config.sample_format()) {
            return Ok(config);
        }
    }
    Err(format!(
        "No usable input config for '{}'",
        device.name().unwrap_or_else(|_| "unknown".into())
    ))
}
