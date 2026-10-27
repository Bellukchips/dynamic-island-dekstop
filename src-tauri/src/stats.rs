use serde::Serialize;
use std::thread;
use std::time::Duration;
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Stats {
    // CPU
    cpu: f32,                 // persen 0..100
    cpu_cores: usize,         // jumlah logical processor/thread
    cpu_freq_mhz: u64,        // frekuensi rata-rata yang dilaporkan OS
    cpu_name: String,

    // RAM dan swap
    ram: f32,
    ram_used: f64,
    ram_total: f64,
    swap: f32,
    swap_used: f64,
    swap_total: f64,

    // Partisi sistem utama
    disk: f32,
    disk_used: f64,
    disk_total: f64,
    disk_label: String,

    // Jaringan: byte per detik dari interval refresh terakhir
    down: f64,
    up: f64,

    // Ringkasan sistem
    processes: usize,
    uptime_secs: u64,
    host_name: String,
    os_name: String,
    os_version: String,
    kernel_version: String,
}

fn percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32
    }
}

fn primary_disk(disks: &Disks) -> Option<&sysinfo::Disk> {
    #[cfg(target_os = "windows")]
    {
        let system_drive = std::env::var("SystemDrive")
            .unwrap_or_else(|_| "C:".to_string())
            .to_ascii_lowercase();
        disks
            .iter()
            .find(|disk| {
                disk.mount_point()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with(&system_drive)
            })
            .or_else(|| disks.iter().max_by_key(|disk| disk.total_space()))
    }

    #[cfg(target_os = "macos")]
    {
        disks
            .iter()
            .find(|disk| disk.mount_point() == Path::new("/System/Volumes/Data"))
            .or_else(|| disks.iter().find(|disk| disk.mount_point() == Path::new("/")))
            .or_else(|| disks.iter().max_by_key(|disk| disk.total_space()))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        disks
            .iter()
            .find(|disk| disk.mount_point() == Path::new("/"))
            .or_else(|| disks.iter().max_by_key(|disk| disk.total_space()))
    }
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        // Tetap gunakan instance yang sama agar perhitungan CPU dan jaringan memakai selisih refresh.
        // Muat CPU, memori, dan daftar proses satu kali saat awal.
        let mut sys = System::new_all();
        let mut nets = Networks::new_with_refreshed_list();
        let mut disks = Disks::new_with_refreshed_list();

        let host_name = System::host_name().unwrap_or_else(|| "Perangkat".to_string());
        let os_name = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
        let os_version = System::os_version().unwrap_or_default();
        let kernel_version = System::kernel_version().unwrap_or_default();

        let mut process_refresh_ticks = 0u8;

        loop {
            thread::sleep(Duration::from_millis(1000));

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            nets.refresh(true);
            disks.refresh(true);

            // Refresh daftar proses lebih jarang agar pemantauan tidak terlalu membebani sistem.
            process_refresh_ticks = process_refresh_ticks.saturating_add(1);
            if process_refresh_ticks >= 5 {
                sys.refresh_processes(ProcessesToUpdate::All, true);
                process_refresh_ticks = 0;
            }

            // received()/transmitted() menunjukkan byte sejak refresh jaringan sebelumnya.
            let (mut rx, mut tx) = (0u64, 0u64);
            for (_, network) in nets.iter() {
                rx = rx.saturating_add(network.received());
                tx = tx.saturating_add(network.transmitted());
            }

            let ram_total = sys.total_memory();
            let ram_used = sys.used_memory();
            let swap_total = sys.total_swap();
            let swap_used = sys.used_swap();

            let cpu_list = sys.cpus();
            let cpu_cores = cpu_list.len();
            let cpu_freq_mhz = if cpu_cores > 0 {
                cpu_list.iter().map(|cpu| cpu.frequency()).sum::<u64>() / cpu_cores as u64
            } else {
                0
            };
            let cpu_name = cpu_list
                .first()
                .map(|cpu| cpu.brand().trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "CPU".to_string());

            let (disk_used, disk_total, disk_label) = primary_disk(&disks)
                .map(|disk| {
                    let total = disk.total_space();
                    let available = disk.available_space();
                    (
                        total.saturating_sub(available),
                        total,
                        disk.mount_point().to_string_lossy().to_string(),
                    )
                })
                .unwrap_or_else(|| (0, 0, "Penyimpanan N/A".to_string()));

            let _ = app.emit(
                "stats",
                Stats {
                    cpu: sys.global_cpu_usage().clamp(0.0, 100.0),
                    cpu_cores,
                    cpu_freq_mhz,
                    cpu_name,
                    ram: percent(ram_used, ram_total),
                    ram_used: ram_used as f64,
                    ram_total: ram_total as f64,
                    swap: percent(swap_used, swap_total),
                    swap_used: swap_used as f64,
                    swap_total: swap_total as f64,
                    disk: percent(disk_used, disk_total),
                    disk_used: disk_used as f64,
                    disk_total: disk_total as f64,
                    disk_label,
                    down: rx as f64,
                    up: tx as f64,
                    processes: sys.processes().len(),
                    uptime_secs: System::uptime(),
                    host_name: host_name.clone(),
                    os_name: os_name.clone(),
                    os_version: os_version.clone(),
                    kernel_version: kernel_version.clone(),
                },
            );
        }
    });
}
