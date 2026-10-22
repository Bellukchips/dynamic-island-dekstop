use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Battery {
    percent: u8,
    charging: bool,
}

// ======================= Linux =======================
#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let dir = std::fs::read_dir("/sys/class/power_supply")
            .ok()
            .and_then(|d| {
                d.flatten().find(|e| {
                    std::fs::read_to_string(e.path().join("type"))
                        .map(|t| t.trim() == "Battery")
                        .unwrap_or(false)
                        && e.path().join("capacity").exists()
                })
            })
            .map(|e| e.path());

        let Some(dir) = dir else {
            println!("baterai tidak ditemukan (PC desktop?), modul baterai dilewati");
            return;
        };
        println!("baterai ditemukan: {:?}", dir);

        loop {
            let percent = std::fs::read_to_string(dir.join("capacity"))
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let status = std::fs::read_to_string(dir.join("status")).unwrap_or_default();
            let charging = matches!(status.trim(), "Charging" | "Full");
            let _ = app.emit("battery", Battery { percent, charging });
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

// ======================= Windows =======================
#[cfg(target_os = "windows")]
pub fn start(app: AppHandle) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    std::thread::spawn(move || loop {
        let mut s = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut s) }.is_ok() {
            // BatteryFlag 128 = tidak ada baterai, 255 = tidak diketahui
            if s.BatteryFlag == 128 || s.BatteryLifePercent > 100 {
                println!("baterai tidak ditemukan (PC desktop?), modul baterai dilewati");
                return;
            }
            let _ = app.emit(
                "battery",
                Battery {
                    percent: s.BatteryLifePercent,
                    charging: s.ACLineStatus == 1,
                },
            );
        }
        std::thread::sleep(Duration::from_secs(5));
    });
}