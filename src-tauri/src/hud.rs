use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
struct HudEvent {
    kind: &'static str, // "volume" | "brightness"
    value: u8,          // 0-100
    muted: bool,
}

pub fn start(app: AppHandle) {
    imp::start(app);
}

// ======================= Linux =======================
#[cfg(target_os = "linux")]
mod imp {
    use super::HudEvent;
    use std::process::Command;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(cmd).args(args).output().ok()?;
        if !o.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&o.stdout).to_string())
    }

    // "Volume: 0.45" atau "Volume: 0.45 [MUTED]"
    fn volume_wpctl() -> Option<(u8, bool)> {
        let s = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"])?;
        let v: f64 = s.split_whitespace().nth(1)?.parse().ok()?;
        Some(((v * 100.0).round().clamp(0.0, 150.0) as u8, s.contains("MUTED")))
    }

    // cadangan untuk PulseAudio murni
    fn volume_pactl() -> Option<(u8, bool)> {
        let s = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"])?;
        let i = s.find('%')?;
        let digits: String = s[..i]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let v: u8 = digits.parse().ok()?;
        let muted = run("pactl", &["get-sink-mute", "@DEFAULT_SINK@"])
            .map(|m| m.contains("yes"))
            .unwrap_or(false);
        Some((v, muted))
    }

    fn brightness() -> Option<u8> {
        for e in std::fs::read_dir("/sys/class/backlight").ok()?.flatten() {
            let p = e.path();
            let cur: f64 = std::fs::read_to_string(p.join("brightness")).ok()?.trim().parse().ok()?;
            let max: f64 = std::fs::read_to_string(p.join("max_brightness")).ok()?.trim().parse().ok()?;
            if max > 0.0 {
                return Some((cur * 100.0 / max).round() as u8);
            }
        }
        None
    }

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            let mut last_vol = volume_wpctl().or_else(volume_pactl);
            let mut last_br = brightness();
            println!("hud: volume={:?} brightness={:?}", last_vol, last_br);

            loop {
                std::thread::sleep(Duration::from_millis(250));

                let v = volume_wpctl().or_else(volume_pactl);
                if v.is_some() && v != last_vol {
                    last_vol = v;
                    let (value, muted) = v.unwrap();
                    let _ = app.emit("hud", HudEvent { kind: "volume", value, muted });
                }

                let b = brightness();
                if b.is_some() && b != last_br {
                    last_br = b;
                    let _ = app.emit("hud", HudEvent { kind: "brightness", value: b.unwrap(), muted: false });
                }
            }
        });
    }
}

// ======================= Windows =======================
#[cfg(target_os = "windows")]
mod imp {
    use super::HudEvent;
    use std::io::{BufRead, BufReader};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    const NO_WINDOW: u32 = 0x0800_0000;

    fn volume() -> windows::core::Result<(u8, bool)> {
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let vol = dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)?;
            let v = vol.GetMasterVolumeLevelScalar()?;
            let m = vol.GetMute()?.as_bool();
            Ok(((v * 100.0).round() as u8, m))
        }
    }

    // kecerahan layar (hanya laptop / monitor internal) lewat WMI
    const BR_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $b = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness
  if ($b -ne $null) { "B|$b" }
  Start-Sleep -Milliseconds 700
}
"#;

    fn brightness_watcher(app: AppHandle) {
        let child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", BR_SCRIPT])
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else { return };
        let Some(out) = child.stdout.take() else { return };

        let mut last: Option<u8> = None;
        let mut first = true;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(v) = line.trim().strip_prefix("B|").and_then(|s| s.parse::<u8>().ok()) {
                if !first && Some(v) != last {
                    let _ = app.emit("hud", HudEvent { kind: "brightness", value: v, muted: false });
                }
                first = false;
                last = Some(v);
            }
        }
    }

    pub fn start(app: AppHandle) {
        let a = app.clone();
        std::thread::spawn(move || brightness_watcher(a));

        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();
            }
            let mut last = volume().ok();
            println!("hud: volume={:?}", last);

            loop {
                std::thread::sleep(Duration::from_millis(250));
                if let Ok(v) = volume() {
                    if Some(v) != last {
                        last = Some(v);
                        let _ = app.emit("hud", HudEvent { kind: "volume", value: v.0, muted: v.1 });
                    }
                }
            }
        });
    }
}