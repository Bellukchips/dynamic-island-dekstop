# Notch

Aplikasi desktop bergaya *notch* untuk Windows dan Linux. Pil kecil di tepi layar membuka hub berisi media, lirik, cuaca, timer, pengingat, catatan, clipboard, shelf file, dan lainnya. Antarmukanya memakai TypeScript dan Vite, sisi sistemnya memakai Rust lewat Tauri 2.

Situs fitur: `https://USERNAME.github.io/REPO/` (lihat [GitHub Pages](#github-pages)).

## Fitur

| Halaman / fitur | Keterangan |
| --- | --- |
| `media` | Judul, artis, cover, kontrol putar, dan geser progress. Aksen warna mengikuti cover. |
| `lyrics` | Lirik bersinkron, juga tampil satu baris di notch ringkas. |
| `clock` | Jam dan tanggal. Klik tanggal untuk kalender dengan hari libur Indonesia. |
| `weather` | Suhu, kelembapan, dan peringatan hujan. |
| `battery` | Persentase dan status mengisi. |
| `timer` | Pomodoro: fokus, istirahat, istirahat panjang. |
| `quick`, `tools` | Mic, Wi-Fi, Bluetooth, keep awake, tema gelap/terang. |
| `stats` | CPU, RAM, kecepatan jaringan. |
| `reminder` | Pengingat dengan tanggal, jam, ulang harian/bulanan, tunda, dan bunyi. |
| `notes` | Catatan permanen dengan jendela detail. |
| `clipboard` | Riwayat clipboard. |
| `shelf` | Seret file masuk, seret keluar ke aplikasi lain. |
| `prayer` | Jadwal dan pengingat waktu shalat. |
| `privacy` | Indikator saat mic atau kamera dipakai. |

Fitur lain yang selalu aktif:

- Kartu Bluetooth dan perangkat (USB, charger, keyboard, mouse) saat dicolok atau dicabut.
- HUD volume dan kecerahan di notch.
- Mata yang mengikuti kursor, 8 ekspresi, dan 10 tema mata.
- Notch bisa digeser ke mana saja (berubah jadi bola), menempel ke tepi atas, bawah, kiri, atau kanan.
- Ikon tray: Pengaturan, Pusatkan Notch, Keluar. Autostart saat login.
- Banner pemberitahuan versi baru.

## Prasyarat

| Alat | Keterangan |
| --- | --- |
| [Rust](https://rustup.rs) (stable) | Pasang lewat `rustup`. |
| [Node.js](https://nodejs.org) 18 atau lebih baru | Sudah termasuk `npm`. |
| Git | Untuk mengunduh repositori. |

Tauri juga membutuhkan pustaka bawaan tiap sistem operasi. Ikuti bagian sesuai sistem Anda, lalu lanjut ke [Instalasi](#instalasi).

### Windows

1. Pasang **Microsoft C++ Build Tools** dari [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) dan centang **Desktop development with C++**.
2. Pastikan **WebView2 Runtime** terpasang. Windows 10 (terbaru) dan Windows 11 sudah menyertakannya.
3. Pasang Rust: `winget install --id Rustlang.Rustup`, atau jalankan `rustup-init.exe` dari [rustup.rs](https://rustup.rs).
4. Buka terminal baru, lalu cek `rustc --version` dan `cargo --version`.
5. Pastikan toolchain MSVC: `rustup default stable-msvc`.

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libgtk-layer-shell-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

### Arch Linux

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool gtk-layer-shell
sudo pacman -S rustup
rustup default stable
```

### macOS

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
```

Fitur sistem (Bluetooth, perangkat, pemantau mic/kamera, kecerahan) saat ini ditulis untuk Windows dan Linux. Distribusi lain memakai nama paket berbeda, lihat [prasyarat Tauri](https://tauri.app/start/prerequisites/).

## Instalasi

```bash
git clone https://github.com/USERNAME/REPO.git
cd REPO
npm install
npm i -D @types/node
```

Cargo mengunduh dependensi Rust otomatis saat build pertama, yang memakan waktu beberapa menit.

## Menjalankan

```bash
npm run tauri dev      # mode pengembangan dengan hot reload
npm run tauri build    # build rilis
```

Hasil build ada di `src-tauri/target/release/`, installer di `src-tauri/target/release/bundle/`.

## Struktur proyek

```
.
├── index.html            # jendela utama (notch)
├── settings.html         # jendela pengaturan
├── note-detail.html      # jendela detail catatan
├── docs/
│   └── index.html        # situs GitHub Pages (tidak ikut build aplikasi)
├── vite.config.ts
├── package.json
├── src/                  # main.ts, clock, calendar, prayer, nudge, hub-nav, firebase
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    └── src/              # lib.rs + modul: media, battery, bluetooth, devices, hud,
                          # weather, stats, clipboard, privacy, lyrics, shelf,
                          # notes, reminder, prayer, quick, config, autostart
```

Vite hanya membangun halaman yang terdaftar di `build.rollupOptions.input` pada `vite.config.ts`, jadi `docs/` tidak ikut masuk aplikasi.

## Konfigurasi

Rust membaca `config.toml` lalu menyuntikkannya ke antarmuka sebagai `window.__CFG__`. Kunci yang kosong memakai nilai bawaan di `main.ts`.

```toml
scale = 1.0
pages = ["media", "clock", "weather", "battery", "timer", "quick", "tools",
         "stats", "reminder", "notes", "clipboard", "shelf", "lyrics",
         "privacy", "prayer"]

[appearance]
theme = "auto"          # "auto", "light", "dark", atau "custom"
background = "#000000"  # dipakai saat theme = "custom"
text = ""               # kosong = warna teks otomatis
dark_bg = "#000000"
light_bg = "#f5f5f7"
accent = ""             # kosong = mengikuti cover album
default_mood = "normal" # normal, happy, sleepy, surprised, angry, love, suspicious, sad
eye_theme = "aurora"    # aurora, neon, pastel, pixel, holo, ember, ocean, sakura, cyber, monochrome

[timing]
hub_auto_ms = 4000
card_ms = 3500
hud_ms = 1500
hover_open_ms = 150
hover_close_ms = 450
sleep_after_s = 60

[pomodoro]
focus_min = 25
break_min = 5
long_break_min = 15
rounds = 4
```

Urutan `pages` menentukan urutan halaman di hub. Hapus namanya untuk menyembunyikan halaman, dan tambahkan `privacy` untuk menyalakan indikator mic/kamera. Perubahan dari Pengaturan langsung terlihat lewat event `config-changed`.

Posisi notch yang digeser disimpan di tabel `[position]` (`custom`, `x`, `y`).

## Kontrak antara Rust dan antarmuka

**Command** (dipanggil dengan `invoke`):

| Kelompok | Command |
| --- | --- |
| Jendela | `set_size`, `set_hit_area`, `set_drag_out`, `notch_monitor`, `open_note_detail` |
| Posisi | `notch_start_move`, `notch_move_to`, `notch_end_move`, `notch_reset_position`, `notch_get_position` |
| Media | `media_control`, `media_seek`, `lyrics_fetch` |
| Kontrol cepat | `quick_state`, `quick_toggle` |
| Clipboard | `clip_list`, `clip_copy`, `clip_clear` |
| Shelf | `shelf_list`, `shelf_add`, `shelf_remove`, `shelf_clear`, `shelf_open`, `shelf_reveal`, `shelf_log` |
| Catatan | `notes_list`, `notes_add`, `notes_update`, `notes_remove`, `notes_clear` |
| Pengingat | `reminders_list`, `reminders_add`, `reminders_toggle`, `reminders_remove`, `reminders_clear_done`, `reminders_stop`, `reminders_snooze` |
| Shalat | `prayer_month`, `prayer_info`, `prayer_set_prefs` |
| Konfigurasi | `cfg_get`, `cfg_preview`, `cfg_save`, `cfg_restart`, `nudge_test`, `autostart_get`, `autostart_set`, `bt_list` |

**Event** (didengarkan dengan `listen`):

`cursor`, `media`, `media-art`, `bluetooth`, `battery`, `device`, `weather`, `hud`, `stats`, `clipboard`, `privacy`, `reminder-due`, `notes-changed`, `note-open`, `position-changed`, `config-changed`

Command harus terdaftar di `generate_handler!`, dan jendela yang memanggilnya perlu izin di `src-tauri/capabilities/`.

## Tes manual lewat keyboard

| Tombol | Aksi |
| --- | --- |
| `1`–`7` | Ganti ekspresi mata |
| `T` | Ganti wajah notch: mata atau jam |
| `K` | Buka kalender |
| `M` | Demo indikator mic/kamera |
| `B` | Kartu Bluetooth |
| `C` / `V` / `L` | Baterai normal / mengisi / rendah |
| `D` | Kartu perangkat contoh |
| `W` | Peringatan cuaca |
| `H` | Buka hub |
| `U` / `I` | HUD volume / kecerahan |
| `P` | Timer 3 detik |
| `←` `→` | Pindah halaman atau bulan |

## GitHub Pages

Situs fitur ada di `docs/index.html`. Folder `docs/` dipakai karena `index.html` di akar repositori adalah jendela aplikasi, bukan situs.

1. Ganti semua `USERNAME/REPO` di `docs/index.html` dan README ini dengan nama akun dan repositori Anda.
2. Commit dan push ke branch `main`.
3. Buka **Settings → Pages**. Pada **Source** pilih **Deploy from a branch**.
4. Pada **Branch** pilih `main`, ubah folder dari `/ (root)` menjadi `/docs`, lalu klik **Save**.
5. Tunggu 1–2 menit, lalu buka `https://USERNAME.github.io/REPO/`.

Situs GitHub Pages bersifat publik meski kodenya Anda simpan di repositori privat. Visibilitas privat hanya tersedia di paket Enterprise.

## Pemecahan masalah

**`Cannot find name 'path'` atau `'__dirname'` di `vite.config.ts`**
Jalankan `npm i -D @types/node`, atau pakai path relatif pada `rollupOptions.input`.

**`Port 1420 is already in use`**
Hentikan proses yang memakai port 1420, lalu jalankan ulang.

**Build Rust pertama gagal di Linux**
Ada pustaka sistem yang belum terpasang. Baca pesan error dan pasang paket yang disebut.

**Jendela tidak merespons klik di Windows**
Jendela *click-through* tidak menerima event mouse. Hover dihitung dari posisi kursor global dari event `cursor`, jadi pastikan event itu berjalan.

**Linux Wayland: posisi atau klik tidak berfungsi**
Secara bawaan aplikasi berjalan lewat XWayland. Untuk mode native (layer-shell) jalankan dengan `NOTCH_NATIVE=1`.

**Volume atau kecerahan bawaan Windows masih muncul**
OSD Windows dimiliki Explorer dan tidak bisa disembunyikan dari dalam aplikasi ini. Pakai alat terpisah seperti HideVolumeOSD atau ModernFlyouts.

## Skrip yang berguna

```bash
npm run tauri dev
npm run tauri build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Lisensi

Tambahkan lisensi proyek Anda di sini.
