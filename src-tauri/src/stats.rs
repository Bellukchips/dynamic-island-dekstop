use serde::Serialize;
use std::time::Duration;
use sysinfo::{Networks, System};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Stats {
    cpu: f32,       // persen 0-100
    ram: f32,       // persen 0-100
    ram_used: f64,  // byte
    ram_total: f64, // byte
    down: f64,      // byte per detik
    up: f64,        // byte per detik
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut nets = Networks::new_with_refreshed_list();

        loop {
            std::thread::sleep(Duration::from_millis(1000));

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            nets.refresh(true); // sysinfo 0.32+: true = buang adapter yang sudah hilang

            // received()/transmitted() = jumlah byte sejak refresh terakhir (~1 detik)
            let (mut rx, mut tx) = (0u64, 0u64);
            for (_, n) in nets.iter() {
                rx += n.received();
                tx += n.transmitted();
            }

            let total = sys.total_memory() as f64;
            let used = sys.used_memory() as f64;

            let _ = app.emit(
                "stats",
                Stats {
                    cpu: sys.global_cpu_usage(),
                    ram: if total > 0.0 { (used / total * 100.0) as f32 } else { 0.0 },
                    ram_used: used,
                    ram_total: total,
                    down: rx as f64,
                    up: tx as f64,
                },
            );
        }
    });
}