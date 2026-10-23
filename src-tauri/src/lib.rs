use tauri::Emitter;
use tauri::{Manager, PhysicalPosition};

mod autostart;
mod battery;
mod bluetooth;
mod config;
mod devices;
mod hud;
mod media;
mod quick;
mod weather;
mod stats;
mod fullscreen;
mod clipboard;
mod privacy;
mod lyrics;
mod shelf;
#[cfg(target_os = "windows")]
mod winps;
// area klik pil (x, lebar, tinggi) dalam piksel logis. Dipakai di Windows.
#[cfg(target_os = "windows")]
static HIT: std::sync::Mutex<(i32, i32, i32)> = std::sync::Mutex::new((5, 130, 24));

// Pusatkan jendela di tengah atas berdasarkan ukuran ASLI jendela saat ini
fn center_top(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let (Some(m), Ok(size)) = (monitor, window.outer_size()) {
        let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
        let _ = window.set_position(PhysicalPosition::new(x, m.position().y));
    }
}

// pusatkan beberapa kali karena compositor menerapkan ukuran dengan jeda
fn center_later(window: &tauri::WebviewWindow) {
    let win = window.clone();
    std::thread::spawn(move || {
        for ms in [60u64, 150, 300] {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            center_top(&win);
        }
    });
}

// jendela pengaturan (dibuat saat diminta, dipakai ulang kalau sudah ada)
fn open_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Notch — Pengaturan")
    .inner_size(440.0, 660.0)
    .resizable(false)
    .build();
}

#[tauri::command]
fn set_size(window: tauri::WebviewWindow, w: f64, h: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    center_top(&window);
    center_later(&window);
}

// Hanya area (x, 0, w, h) yang menerima klik. Sisanya tembus ke aplikasi di bawahnya.
#[tauri::command]
fn set_hit_area(window: tauri::WebviewWindow, x: i32, w: i32, h: i32) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(gtk_win) = win.gtk_window() {
                if let Some(gdk_win) = gtk_win.window() {
                    let region = gtk::cairo::Region::create_rectangle(
                        &gtk::cairo::RectangleInt::new(x, 0, w, h),
                    );
                    gdk_win.input_shape_combine_region(&region, 0, 0);
                }
            }
        });
    }
    #[cfg(target_os = "windows")]
    {
        let _ = window;
        *HIT.lock().unwrap() = (x, w, h);
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (window, x, w, h);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Wayland: default ke XWayland supaya posisi dan klik berfungsi.
    // Untuk mencoba mode native (layer-shell): NOTCH_NATIVE=1
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false);
        if wayland
            && std::env::var_os("NOTCH_NATIVE").is_none()
            && std::env::var_os("GDK_BACKEND").is_none()
        {
            unsafe { std::env::set_var("GDK_BACKEND", "x11") };
        }
    }

    config::init();

    // konfigurasi dikirim ke frontend sebelum main.ts jalan (window.__CFG__)
    let script = format!(
        "window.__CFG__ = {};",
        serde_json::to_string(config::get()).unwrap_or_else(|_| "{}".into())
    );
    let cfg_plugin: tauri::plugin::TauriPlugin<tauri::Wry> =
        tauri::plugin::Builder::new("notch-config")
            .js_init_script(script)
            .build();

    tauri::Builder::default()
        .plugin(cfg_plugin)
        .setup(|app| {
            let win = app.get_webview_window("main").unwrap();

            #[allow(unused_mut)]
            let mut layer_ok = false;

            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::*;
                use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};

                let gtk_win = win.gtk_window()?;
                let native = std::env::var_os("NOTCH_NATIVE").is_some();
                println!(
                    "layer-shell: didukung={} realized={} native_diminta={}",
                    gtk_layer_shell::is_supported(),
                    gtk_win.is_realized(),
                    native
                );

                if native && gtk_layer_shell::is_supported() && !gtk_win.is_realized() {
                    gtk_win.init_layer_shell();
                    gtk_win.set_layer(Layer::Overlay);
                    gtk_win.set_anchor(Edge::Top, true); // hanya atas = otomatis di tengah
                    gtk_win.set_keyboard_mode(KeyboardMode::None);
                    gtk_win.set_exclusive_zone(-1);
                    gtk_win.set_default_size(160, 40);
                    gtk_win.set_size_request(160, 40);
                    layer_ok = true;
                    println!("layer-shell: aktif");
                } else if native {
                    println!("layer-shell: GAGAL diaktifkan (lihat nilai di atas)");
                }
            }

            win.show()?;

            // posisi kursor untuk mata (~30 fps). Di Windows sekaligus mengatur click-through.
            #[cfg(target_os = "windows")]
            let mut last_inside = true;
            let w = win.clone();
            std::thread::spawn(move || {
              // kirim posisi hanya saat kursor bergerak (plus denyut ~4x/detik saat diam,
              // karena frontend menghitung ulang hover saat ukuran notch berubah)
              let mut last_emit = (i32::MIN, i32::MIN);
              let mut still: u32 = 0;
              loop {
                if let (Ok(cur), Ok(pos), Ok(size), Ok(scale)) = (
                    w.cursor_position(),
                    w.outer_position(),
                    w.outer_size(),
                    w.scale_factor(),
                ) {
                    let cx = pos.x as f64 + size.width as f64 / 2.0;
                    let cy = pos.y as f64 + 12.0 * scale;
                    let (dx, dy) = ((cur.x - cx) / scale, (cur.y - cy) / scale);
                    let key = (dx.round() as i32, dy.round() as i32);
                    let send = if key != last_emit {
                        last_emit = key;
                        still = 0;
                        true
                    } else {
                        still = still.wrapping_add(1);
                        still % 8 == 0
                    };
                    if send {
                        let _ = w.emit("cursor", serde_json::json!({ "dx": dx, "dy": dy }));
                    }

                    #[cfg(target_os = "windows")]
                    {
                        let (hx, hw, hh) = *HIT.lock().unwrap();
                        let left = pos.x as f64 + hx as f64 * scale;
                        let inside = cur.x >= left
                            && cur.x <= left + hw as f64 * scale
                            && cur.y >= pos.y as f64
                            && cur.y <= pos.y as f64 + hh as f64 * scale;
                        if inside != last_inside {
                            last_inside = inside;
                            let _ = w.set_ignore_cursor_events(!inside);
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(33));
              }
            });

            // Fallback X11/XWayland dan Windows: posisikan manual
            if !layer_ok {
                let _ = win.set_size(tauri::LogicalSize::new(160.0, 40.0));
                center_top(&win);
                center_later(&win);
            }

            // ikon tray: Pengaturan + Keluar (notch tidak punya taskbar).
            // Tidak fatal: saat dijalankan otomatis ketika login, tray kadang belum siap
            // (mis. GNOME tanpa AppIndicator); aplikasi tetap harus jalan.
            let tray_result: Result<(), Box<dyn std::error::Error>> = (|| {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                let mi_set = MenuItem::with_id(app, "settings", "Pengaturan", true, None::<&str>)?;
                let mi_quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&mi_set, &mi_quit])?;
                let mut tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Notch")
                    .on_menu_event(|app, e| match e.id.as_ref() {
                        "settings" => {
                            // thread terpisah: membuat window di event handler bisa deadlock di Windows
                            let a = app.clone();
                            std::thread::spawn(move || open_settings(&a));
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
                Ok(())
            })();
            if let Err(e) = tray_result {
                eprintln!("tray gagal dibuat (pengaturan tidak bisa dibuka lewat tray): {e}");
            }

            bluetooth::start(app.handle().clone());
            battery::start(app.handle().clone());
            devices::start(app.handle().clone());
            hud::start(app.handle().clone());
            weather::start(app.handle().clone());
            fullscreen::start(app.handle().clone());
            media::start(app.handle().clone());
            stats::start(app.handle().clone()); 
            clipboard::start(app.handle().clone()); 
            privacy::start(app.handle().clone());
            shelf::start(app.handle().clone());
            // setelah semua modul mendaftar: satu PowerShell bersama untuk perangkat/kecerahan/Bluetooth
            #[cfg(target_os = "windows")]
            winps::start();
            Ok(())
        })
        .on_window_event(|window, event| {
            // jendela pengaturan ditutup tanpa simpan -> kembalikan tampilan notch ke isi file
            if window.label() == "settings" {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = window.app_handle().emit("config-changed", config::cfg_get());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            media::media_control,
            set_size,
            set_hit_area,
            quick::quick_state,
            quick::quick_toggle,
            clipboard::clip_list,
            clipboard::clip_copy,
            clipboard::clip_clear,
            lyrics::lyrics_fetch,
            shelf::shelf_list,
            shelf::shelf_add,
            shelf::shelf_remove,
            shelf::shelf_clear,
            shelf::shelf_open,
            shelf::shelf_reveal,
            config::cfg_get,
            config::cfg_preview,
            config::cfg_save,
            config::cfg_restart,
            config::nudge_test,
            bluetooth::bt_list,
            autostart::autostart_get,
            autostart::autostart_set
        ])
        .run(tauri::generate_context!())
        .expect("gagal menjalankan aplikasi");
}