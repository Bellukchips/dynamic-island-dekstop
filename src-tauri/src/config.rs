use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::OnceLock};

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Weather {
    pub lat: f64,
    pub lon: f64,
    pub city: String,
}
impl Default for Weather {
    fn default() -> Self {
        Self { lat: -6.9175, lon: 107.6191, city: "Bandung".into() }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Timing {
    pub hub_auto_ms: u32,    // lama hub terbuka otomatis (lagu baru, alert hujan)
    pub card_ms: u32,        // lama kartu bluetooth / perangkat
    pub hud_ms: u32,         // lama HUD volume / brightness
    pub hover_open_ms: u32,  // jeda sebelum hub terbuka saat hover
    pub hover_close_ms: u32, // jeda sebelum hub menutup setelah kursor keluar
    pub sleep_after_s: u32,  // mata mengantuk setelah tanpa aktivitas
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            hub_auto_ms: 4000,
            card_ms: 3500,
            hud_ms: 1500,
            hover_open_ms: 150,
            hover_close_ms: 450,
            sleep_after_s: 60,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Pomodoro {
    pub focus_min: u32,
    pub break_min: u32,
    pub long_break_min: u32,
    pub rounds: u32,
}
impl Default for Pomodoro {
    fn default() -> Self {
        Self { focus_min: 25, break_min: 5, long_break_min: 15, rounds: 4 }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Appearance {
    pub theme: String,      // "auto" (ikut OS) | "dark" | "light" | "custom"
    pub background: String, // dipakai kalau theme = "custom", mis. "#1e1e2e"
    pub text: String,       // kosong = otomatis hitam/putih sesuai kontras
    pub dark_bg: String,    // warna notch saat tema gelap
    pub light_bg: String,   // warna notch saat tema terang
    pub accent: String,     // kosong = otomatis dari cover album
}
impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "auto".into(),
            background: "#000000".into(),
            text: String::new(),
            dark_bg: "#000000".into(),
            light_bg: "#f5f5f7".into(),
            accent: String::new(),
        }
    }
}

// Catatan: di TOML, nilai biasa (scale, hide_fullscreen, pages) harus berada
// SEBELUM tabel (weather, timing, pomodoro), jadi urutan field di sini penting.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    pub scale: f64,            // 1.0 = normal, 0.8 = 80%
    pub hide_fullscreen: bool, // sembunyikan notch saat game/video fullscreen
    pub pages: Vec<String>,    // urutan halaman hub: media, weather, battery, timer, quick, tools
    pub weather: Weather,
    pub timing: Timing,
    pub pomodoro: Pomodoro,
    pub appearance: Appearance,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            scale: 1.0,
            hide_fullscreen: true,
            pages: ["media", "weather", "battery", "timer", "quick", "tools", "stats", "clipboard"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            weather: Weather::default(),
            timing: Timing::default(),
            pomodoro: Pomodoro::default(),
            appearance: Appearance::default(),
        }
    }
}

static CFG: OnceLock<Config> = OnceLock::new();

pub fn path() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));

    base.unwrap_or_else(|| PathBuf::from(".")).join("notch").join("config.toml")
}

// template bawaan (lengkap dengan komentar) untuk instalasi baru
const DEFAULT_TOML: &str = include_str!("default_config.toml");

// ditambahkan ke config.toml lama yang belum punya section [appearance]
const APPEARANCE_BLOCK: &str = r##"
[appearance]
# theme: auto (ikut OS) | dark | light | custom
theme = "auto"
background = "#1e1e2e"  # hanya untuk theme = "custom"
text = ""               # kosong = otomatis kontras
dark_bg = "#000000"
light_bg = "#f5f5f7"
accent = ""             # kosong = otomatis dari cover album, contoh: "#ff6b6b"
"##;

pub fn init() {
    let p = path();
    let mut cfg = match std::fs::read_to_string(&p) {
        Ok(s) => {
            // user lama: tambahkan blok [appearance] di akhir file kalau belum ada
            if !s.contains("[appearance]") {
                use std::io::Write;
                let _ = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&p)
                    .and_then(|mut f| f.write_all(APPEARANCE_BLOCK.as_bytes()));
            }
            toml::from_str::<Config>(&s).unwrap_or_else(|e| {
                eprintln!("config: file rusak, memakai bawaan ({e})");
                Config::default()
            })
        }
        Err(_) => {
            // pertama kali: tulis template bawaan supaya mudah diedit
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&p, DEFAULT_TOML);
            toml::from_str::<Config>(DEFAULT_TOML).unwrap_or_default()
        }
    };
    cfg.scale = cfg.scale.clamp(0.5, 1.5);
    if cfg.pages.is_empty() {
        cfg.pages = Config::default().pages;
    }
    println!("config: {}", p.display());
    let _ = CFG.set(cfg);
}

pub fn get() -> &'static Config {
    CFG.get_or_init(Config::default)
}

// ======================= command untuk jendela pengaturan =======================

// baca dari file (bukan dari CFG statis) supaya selalu yang terbaru
#[tauri::command]
pub fn cfg_get() -> Config {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default()
}

// pratinjau langsung: hanya dikirim ke notch, tidak menulis file
#[tauri::command]
pub fn cfg_preview(app: tauri::AppHandle, cfg: Config) {
    use tauri::Emitter;
    let _ = app.emit("config-changed", &cfg);
}

// simpan ke config.toml, lalu kabari notch. Mengembalikan lokasi file.
#[tauri::command]
pub fn cfg_save(app: tauri::AppHandle, mut cfg: Config) -> Result<String, String> {
    use tauri::Emitter;
    cfg.scale = cfg.scale.clamp(0.5, 1.5);
    if cfg.pages.is_empty() {
        cfg.pages = Config::default().pages;
    }
    cfg.weather.lat = cfg.weather.lat.clamp(-90.0, 90.0);
    cfg.weather.lon = cfg.weather.lon.clamp(-180.0, 180.0);
    if cfg.weather.city.trim().is_empty() {
        cfg.weather.city = "Lokasi saya".into();
    }
    let p = path();
    let text = toml::to_string_pretty(&cfg).map_err(|e| format!("gagal membuat TOML: {e}"))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("gagal membuat folder: {e}"))?;
    }
    std::fs::write(&p, text).map_err(|e| format!("gagal menulis {}: {e}", p.display()))?;
    println!("config: disimpan ke {}", p.display());
    // lokasi cuaca berlaku langsung tanpa restart
    crate::weather::set_location(cfg.weather.lat, cfg.weather.lon);
    let _ = app.emit("config-changed", &cfg);
    Ok(p.display().to_string())
}

// Restart otomatis hanya di build release. Di `tauri dev`, proses yang keluar
// justru menghentikan sesi dev, jadi di sana dikembalikan pesan saja.
#[tauri::command]
pub fn cfg_restart(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("mode dev: tutup lalu jalankan ulang `npm run tauri dev` secara manual".into());
    }
    app.restart();
}