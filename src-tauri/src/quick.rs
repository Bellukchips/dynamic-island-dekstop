use serde::Serialize;

// mic: true = dimatikan | wifi, bt, awake: true = menyala | dark: true = mode gelap
// null = tidak didukung
#[derive(Serialize, Default, Clone)]
pub struct Quick {
    mic: Option<bool>,
    wifi: Option<bool>,
    bt: Option<bool>,
    awake: Option<bool>,
    dark: Option<bool>,
}

// ======================= Linux =======================
#[cfg(target_os = "linux")]
mod imp {
    use std::process::{Child, Command};
    use std::sync::Mutex;

    static INHIBIT: Mutex<Option<Child>> = Mutex::new(None);

    fn out(cmd: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(cmd).args(args).output().ok()?;
        if !o.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&o.stdout).to_string())
    }

    pub fn mic() -> Option<bool> {
        out("wpctl", &["get-volume", "@DEFAULT_AUDIO_SOURCE@"]).map(|s| s.contains("MUTED"))
    }
    pub fn wifi() -> Option<bool> {
        out("nmcli", &["radio", "wifi"]).map(|s| s.trim() == "enabled")
    }
    pub fn bt() -> Option<bool> {
        out("bluetoothctl", &["show"]).map(|s| s.contains("Powered: yes"))
    }
    pub fn awake() -> Option<bool> {
        Some(INHIBIT.lock().ok()?.is_some())
    }
    pub fn dark() -> Option<bool> {
        out("gsettings", &["get", "org.gnome.desktop.interface", "color-scheme"])
            .map(|s| s.contains("prefer-dark"))
    }

    fn set_awake(on: bool) {
        let Ok(mut g) = INHIBIT.lock() else { return };
        if on {
            if g.is_none() {
                *g = Command::new("systemd-inhibit")
                    .args(["--what=idle:sleep", "--who=notch", "--why=Keep awake", "sleep", "infinity"])
                    .spawn()
                    .ok();
            }
        } else if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    pub fn toggle(kind: &str) {
        match kind {
            "mic" => {
                let _ = out("wpctl", &["set-mute", "@DEFAULT_AUDIO_SOURCE@", "toggle"]);
            }
            "wifi" => {
                let on = wifi().unwrap_or(true);
                let _ = out("nmcli", &["radio", "wifi", if on { "off" } else { "on" }]);
            }
            "bt" => {
                let on = bt().unwrap_or(true);
                let _ = out("bluetoothctl", &["power", if on { "off" } else { "on" }]);
            }
            "awake" => set_awake(!awake().unwrap_or(false)),
            "dark" => {
                let to = if dark().unwrap_or(false) { "default" } else { "prefer-dark" };
                let _ = out("gsettings", &["set", "org.gnome.desktop.interface", "color-scheme", to]);
            }
            "lock" => {
                let _ = out("loginctl", &["lock-session"]);
            }
            _ => {}
        }
    }
}

// ======================= Windows =======================
#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Once;
    use std::time::Duration;
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    const NO_WINDOW: u32 = 0x0800_0000; // cegah jendela konsol berkedip
    const THEME_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    static AWAKE: AtomicBool = AtomicBool::new(false);
    static START: Once = Once::new();

    fn hidden(cmd: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(cmd).args(args).creation_flags(NO_WINDOW).output().ok()?;
        if !o.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&o.stdout).to_string())
    }

    // ---- radio (Wi-Fi / Bluetooth) ----
    fn radio(kind: RadioKind) -> Option<Radio> {
        unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
        let _ = Radio::RequestAccessAsync().ok()?.get();
        let list = Radio::GetRadiosAsync().ok()?.get().ok()?;
        for i in 0..list.Size().ok()? {
            let r = list.GetAt(i).ok()?;
            if r.Kind().ok() == Some(kind) {
                return Some(r);
            }
        }
        None
    }
    fn is_on(kind: RadioKind) -> Option<bool> {
        radio(kind)?.State().ok().map(|s| s == RadioState::On)
    }
    fn flip(kind: RadioKind) {
        if let Some(r) = radio(kind) {
            let on = r.State().ok() == Some(RadioState::On);
            let next = if on { RadioState::Off } else { RadioState::On };
            if let Ok(op) = r.SetStateAsync(next) { let _ = op.get(); }
        }
    }

    // ---- keep awake: thread khusus, karena SetThreadExecutionState berlaku per thread ----
    fn ensure_awake_thread() {
        START.call_once(|| {
            std::thread::spawn(|| {
                let mut last = false;
                loop {
                    let want = AWAKE.load(Ordering::SeqCst);
                    if want != last {
                        last = want;
                        unsafe {
                            if want {
                                SetThreadExecutionState(
                                    ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                                );
                            } else {
                                SetThreadExecutionState(ES_CONTINUOUS);
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
        });
    }

    // ---- mode gelap ----
    fn broadcast_theme() {
        use windows::core::w;
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                200,
                None,
            );
        }
    }

    pub fn mic() -> Option<bool> { None }
    pub fn wifi() -> Option<bool> { is_on(RadioKind::WiFi) }
    pub fn bt() -> Option<bool> { is_on(RadioKind::Bluetooth) }
    pub fn awake() -> Option<bool> {
        ensure_awake_thread();
        Some(AWAKE.load(Ordering::SeqCst))
    }
    pub fn dark() -> Option<bool> {
        let s = hidden("reg", &["query", THEME_KEY, "/v", "AppsUseLightTheme"])?;
        Some(s.split_whitespace().last() == Some("0x0"))
    }

    pub fn toggle(kind: &str) {
        match kind {
            "wifi" => flip(RadioKind::WiFi),
            "bt" => flip(RadioKind::Bluetooth),
            "awake" => {
                ensure_awake_thread();
                AWAKE.store(!AWAKE.load(Ordering::SeqCst), Ordering::SeqCst);
            }
            "dark" => {
                let value = if dark().unwrap_or(false) { "1" } else { "0" }; // 0 = gelap
                for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
                    let _ = hidden(
                        "reg",
                        &["add", THEME_KEY, "/v", name, "/t", "REG_DWORD", "/d", value, "/f"],
                    );
                }
                broadcast_theme();
            }
            "lock" => {
                let _ = Command::new("rundll32.exe")
                    .arg("user32.dll,LockWorkStation")
                    .creation_flags(NO_WINDOW)
                    .spawn();
            }
            _ => {}
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod imp {
    pub fn mic() -> Option<bool> { None }
    pub fn wifi() -> Option<bool> { None }
    pub fn bt() -> Option<bool> { None }
    pub fn awake() -> Option<bool> { None }
    pub fn dark() -> Option<bool> { None }
    pub fn toggle(_kind: &str) {}
}

fn state() -> Quick {
    Quick {
        mic: imp::mic(),
        wifi: imp::wifi(),
        bt: imp::bt(),
        awake: imp::awake(),
        dark: imp::dark(),
    }
}

#[tauri::command]
pub async fn quick_state() -> Quick {
    state()
}

#[tauri::command]
pub async fn quick_toggle(kind: String) -> Quick {
    imp::toggle(&kind);
    std::thread::sleep(std::time::Duration::from_millis(200));
    state()
}