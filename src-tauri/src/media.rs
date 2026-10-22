use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Clone, Default)]
pub struct MediaState {
    pub active: bool,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub position: f64,
    pub length: f64,
}

// bytes gambar -> data URL (webview tidak boleh membuka file lokal)
pub(crate) fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

pub fn start(app: AppHandle) {
    imp::start(app);
}

#[tauri::command]
pub fn media_control(action: String) {
    imp::control(&action);
}

// ======================= Linux (MPRIS) =======================
#[cfg(target_os = "linux")]
mod imp {
    use super::{data_url, MediaState};
    use mpris::{PlaybackStatus, PlayerFinder};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};

    fn load_art(url: &str) -> Option<String> {
        if let Some(path) = url.strip_prefix("file://") {
            let bytes = std::fs::read(path).ok()?;
            let mime = if path.ends_with(".png") { "image/png" } else { "image/jpeg" };
            Some(data_url(mime, &bytes))
        } else {
            Some(url.to_string())
        }
    }

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            let finder = match PlayerFinder::new() {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("MPRIS tidak tersedia: {e}");
                    return;
                }
            };
            let mut last_art = String::new();

            loop {
                let mut state = MediaState::default();

                if let Ok(player) = finder.find_active() {
                    if let Ok(meta) = player.get_metadata() {
                        state.active = true;
                        state.title = meta.title().unwrap_or("").to_string();
                        state.artist = meta.artists().map(|a| a.join(", ")).unwrap_or_default();
                        state.length = meta.length().map(|d| d.as_secs_f64()).unwrap_or(0.0);
                        state.playing =
                            matches!(player.get_playback_status(), Ok(PlaybackStatus::Playing));
                        state.position = player
                            .get_position()
                            .map(|d| d.as_secs_f64())
                            .unwrap_or(0.0);

                        // artwork hanya dikirim saat berganti
                        let art_url = meta.art_url().unwrap_or("").to_string();
                        if art_url != last_art {
                            last_art = art_url.clone();
                            let art = if art_url.is_empty() { None } else { load_art(&art_url) };
                            let _ = app.emit("media-art", art);
                        }
                    }
                }

                let _ = app.emit("media", state);
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
    }

    pub fn control(action: &str) {
        if let Ok(finder) = PlayerFinder::new() {
            if let Ok(p) = finder.find_active() {
                let _ = match action {
                    "toggle" => p.play_pause(),
                    "next" => p.next(),
                    "prev" => p.previous(),
                    _ => Ok(()),
                };
            }
        }
    }
}

// ======================= Windows (SMTC) =======================
#[cfg(target_os = "windows")]
mod imp {
    use super::{data_url, MediaState};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    fn session() -> windows::core::Result<Session> {
        Manager::RequestAsync()?.get()?.GetCurrentSession()
    }

    fn read_state(s: &Session) -> windows::core::Result<MediaState> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let tl = s.GetTimelineProperties()?;
        let info = s.GetPlaybackInfo()?;

        let playing = info.PlaybackStatus()? == Status::Playing;
        let length = tl.EndTime()?.Duration as f64 / 10_000_000.0;
        let mut position = tl.Position()?.Duration as f64 / 10_000_000.0;

        // SMTC hanya memberi snapshot posisi; saat play, tambahkan waktu yang sudah berlalu
        if playing {
            // LastUpdatedTime: satuan 100 ns sejak 1 Jan 1601 (epoch Windows)
            let updated = tl.LastUpdatedTime()?.UniversalTime as f64 / 10_000_000.0;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
                + 11_644_473_600.0; // selisih epoch 1601 -> 1970 (detik)
            let elapsed = now - updated;
            if elapsed > 0.0 && elapsed < 6.0 * 3600.0 {
                position += elapsed;
            }
        }
        if length > 0.0 {
            position = position.min(length);
        }

        Ok(MediaState {
            active: true,
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            playing,
            position,
            length,
        })
    }

    // artwork dari thumbnail SMTC
    fn thumb(s: &Session) -> Option<String> {
        let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()? as u32;
        if size == 0 || size > 8_000_000 {
            return None;
        }
        let input = stream.GetInputStreamAt(0).ok()?;
        let reader = DataReader::CreateDataReader(&input).ok()?;
        reader.LoadAsync(size).ok()?.get().ok()?;
        let mut buf = vec![0u8; size as usize];
        reader.ReadBytes(&mut buf).ok()?;
        let mime = if buf.starts_with(&[0x89, b'P']) { "image/png" } else { "image/jpeg" };
        Some(data_url(mime, &buf))
    }

    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            let mut last_key = String::new();
            let mut art_done = false;
            let mut tries: u8 = 0;

            loop {
                let mut state = MediaState::default();

                if let Ok(s) = session() {
                    if let Ok(st) = read_state(&s) {
                        // lagu baru -> reset status artwork
                        let key = format!("{}|{}", st.title, st.artist);
                        if key != last_key {
                            last_key = key;
                            art_done = false;
                            tries = 0;
                        }

                        // ulangi sampai thumbnail benar-benar siap
                        if !art_done {
                            match thumb(&s) {
                                Some(img) => {
                                    let _ = app.emit("media-art", Some(img));
                                    art_done = true;
                                }
                                None => {
                                    tries += 1;
                                    if tries >= 8 {
                                        // menyerah: sembunyikan gambar
                                        let _ = app.emit("media-art", None::<String>);
                                        art_done = true;
                                    }
                                }
                            }
                        }
                        state = st;
                    }
                }

                let _ = app.emit("media", state);
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
    }

    pub fn control(action: &str) {
        if let Ok(s) = session() {
            let _ = match action {
                "toggle" => s.TryTogglePlayPauseAsync().map(|_| ()),
                "next" => s.TrySkipNextAsync().map(|_| ()),
                "prev" => s.TrySkipPreviousAsync().map(|_| ()),
                _ => Ok(()),
            };
        }
    }
}