use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub text: String,
    pub updated_at: i64, // unix ms
}

// disimpan sebagai file sendiri di samping config.toml (bukan di dalamnya) supaya
// catatan tetap ada walau config di-reset, dan baru hilang kalau folder data dihapus
fn path() -> PathBuf {
    crate::config::path().with_file_name("notes.json")
}

static NOTES: Mutex<Option<Vec<Note>>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn uid() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("{:x}{:x}", n.as_millis(), n.subsec_nanos())
}

fn load() -> Vec<Note> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(items: &[Note]) {
    if let Some(dir) = path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(path(), text);
    }
}

fn with_items<R>(f: impl FnOnce(&mut Vec<Note>) -> R) -> R {
    let mut guard = NOTES.lock().unwrap();
    if guard.is_none() {
        *guard = Some(load());
    }
    let items = guard.as_mut().unwrap();
    let r = f(items);
    save(items);
    r
}

fn sorted(mut items: Vec<Note>) -> Vec<Note> {
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)); // terbaru di atas
    items
}

#[tauri::command]
pub fn notes_list() -> Vec<Note> {
    with_items(|items| sorted(items.clone()))
}

#[tauri::command]
pub fn notes_add(text: String) -> Vec<Note> {
    with_items(|items| {
        let text: String = text.trim().chars().take(4000).collect();
        if !text.is_empty() {
            items.push(Note { id: uid(), text, updated_at: now_ms() });
        }
        sorted(items.clone())
    })
}

#[tauri::command]
pub fn notes_update(id: String, text: String) -> Vec<Note> {
    with_items(|items| {
        if let Some(n) = items.iter_mut().find(|n| n.id == id) {
            n.text = text.trim().chars().take(4000).collect();
            n.updated_at = now_ms();
        }
        sorted(items.clone())
    })
}

#[tauri::command]
pub fn notes_remove(id: String) -> Vec<Note> {
    with_items(|items| {
        items.retain(|n| n.id != id);
        sorted(items.clone())
    })
}

#[tauri::command]
pub fn notes_clear() -> Vec<Note> {
    with_items(|items| {
        items.clear();
        items.clone()
    })
}