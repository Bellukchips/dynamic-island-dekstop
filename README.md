# Notch

Aplikasi desktop bergaya *notch* yang menampilkan media, cuaca, baterai, timer Pomodoro, kontrol cepat, status sistem, dan riwayat clipboard. Antarmukanya memakai TypeScript dan Vite. Sisi sistemnya memakai Rust lewat Tauri 2.

## Prasyarat

Pasang alat berikut sebelum menjalankan proyek.

| Alat | Keterangan |
| --- | --- |
| [Rust](https://rustup.rs) (stable) | Pasang lewat `rustup`. Langkahnya ada di bagian sistem operasi di bawah. |
| [Node.js](https://nodejs.org) 18 atau lebih baru | Sudah termasuk `npm`. |
| Git | Untuk mengunduh repositori. |

Tauri juga membutuhkan pustaka bawaan tiap sistem operasi. Ikuti bagian sesuai sistem Anda, lalu lanjut ke [Instalasi](#instalasi).

### Windows

1. Pasang **Microsoft C++ Build Tools** dari [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). Saat installer terbuka, centang beban kerja **Desktop development with C++**.
2. Pastikan **WebView2 Runtime** terpasang. Windows 10 (versi terbaru) dan Windows 11 sudah menyertakannya. Kalau belum, unduh dari [developer.microsoft.com/microsoft-edge/webview2](https://developer.microsoft.com/microsoft-edge/webview2/).
3. Pasang Rust. Unduh `rustup-init.exe` dari [rustup.rs](https://rustup.rs), jalankan, lalu pilih opsi bawaan (`1`). Alternatifnya lewat PowerShell:

   ```powershell
   winget install --id Rustlang.Rustup
   ```

4. Tutup terminal, buka lagi, lalu cek instalasi:

   ```powershell
   rustc --version
   cargo --version
   ```

5. Pastikan toolchain memakai MSVC:

   ```powershell
   rustup default stable-msvc
   ```

### Ubuntu / Debian

1. Pasang pustaka sistem untuk Tauri:

   ```bash
   sudo apt update
   sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```

2. Pasang Rust lewat `rustup`:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

   Pilih instalasi bawaan (`1`).

3. Muat ulang environment supaya `cargo` dikenali di terminal yang sedang terbuka:

   ```bash
   . "$HOME/.cargo/env"
   ```

4. Cek instalasi:

   ```bash
   rustc --version
   cargo --version
   ```

### Arch Linux

1. Perbarui sistem, lalu pasang pustaka untuk Tauri:

   ```bash
   sudo pacman -Syu
   sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
     appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
   ```

2. Pasang Rust lewat paket `rustup` dari repositori resmi, lalu pilih toolchain stable:

   ```bash
   sudo pacman -S rustup
   rustup default stable
   ```

   Kalau Anda lebih suka paket sistem, `sudo pacman -S rust` juga bisa dipakai. Namun `rustup` memudahkan pergantian versi dan komponen seperti `clippy`.

3. Cek instalasi:

   ```bash
   rustc --version
   cargo --version
   ```

### macOS

1. Pasang Xcode Command Line Tools:

   ```bash
   xcode-select --install
   ```

2. Pasang Rust:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. Muat ulang environment, lalu cek instalasi:

   ```bash
   . "$HOME/.cargo/env"
   rustc --version
   ```

Distribusi Linux lain memakai nama paket yang berbeda. Lihat daftar lengkapnya di [dokumentasi prasyarat Tauri](https://tauri.app/start/prerequisites/).

## Instalasi

```bash
git clone <url-repositori>
cd <nama-folder>
npm install
```

Pasang tipe Node supaya `vite.config.ts` bebas error di editor:

```bash
npm i -D @types/node
```

Cargo mengunduh dependensi Rust secara otomatis saat build pertama. Build pertama memakan waktu beberapa menit.

## Menjalankan

Mode pengembangan dengan *hot reload*:

```bash
npm run tauri dev
```

Build rilis:

```bash
npm run tauri build
```

Hasil build tersimpan di `src-tauri/target/release/`. Installer ada di `src-tauri/target/release/bundle/`.

## Membuat proyek dari nol

Kalau Anda ingin memulai dari template resmi:

```bash
npm create tauri-app@latest
```

Pilih **TypeScript**, **npm**, dan template **Vanilla**. Setelah itu salin kode antarmuka ke `src/`, lalu salin kode Rust ke `src-tauri/src/`.

## Struktur proyek

```
.
├── index.html            # jendela utama (notch)
├── settings.html         # jendela pengaturan
├── vite.config.ts        # konfigurasi Vite untuk Tauri
├── package.json
├── src/
│   └── main.ts           # logika antarmuka
└── src-tauri/
    ├── Cargo.toml        # dependensi Rust
    ├── tauri.conf.json   # konfigurasi aplikasi Tauri
    └── src/
        └── main.rs       # kode Rust (command dan event)
```

Vite membangun dua halaman, `index.html` dan `settings.html`. Daftar halaman ada di `build.rollupOptions.input` pada `vite.config.ts`.

## Konfigurasi

Rust membaca `config.toml`, lalu menyuntikkan isinya ke antarmuka sebagai `window.__CFG__`. Kunci yang tidak diisi memakai nilai bawaan di `main.ts`. Contoh:

```toml
scale = 1.0
pages = ["media", "weather", "battery", "timer", "quick", "tools", "stats", "clipboard"]

[appearance]
theme = "auto"          # "auto", "light", "dark", atau "custom"
background = "#000000"  # dipakai saat theme = "custom"
text = ""               # kosong = warna teks dipilih otomatis
dark_bg = "#000000"
light_bg = "#ffffff"
accent = ""             # kosong = warna aksen mengikuti artwork lagu

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

Urutan `pages` menentukan urutan halaman di hub. Hapus nama halaman dari daftar untuk menyembunyikannya.

Saat konfigurasi berubah, Rust mengirim event `config-changed` dengan isi `{ appearance }`. Antarmuka langsung menerapkan tema baru tanpa memuat ulang.

## Kontrak antara Rust dan antarmuka

Kode Rust harus menyediakan *command* dan mengirim *event* berikut.

**Command** (dipanggil dengan `invoke`):

| Command | Fungsi |
| --- | --- |
| `set_size` | Mengubah ukuran jendela |
| `set_hit_area` | Mengatur area yang menerima klik |
| `media_control` | Prev, toggle, dan next pada pemutar media |
| `quick_state`, `quick_toggle` | Membaca dan mengubah kontrol cepat |
| `clip_list`, `clip_copy`, `clip_clear` | Riwayat clipboard |

**Event** (didengarkan dengan `listen`):

`cursor`, `media`, `media-art`, `bluetooth`, `battery`, `device`, `weather`, `hud`, `stats`, `clipboard`, `config-changed`

Command harus terdaftar di `generate_handler!`, dan jendela yang memanggilnya harus punya izin di `src-tauri/capabilities/`.

## Tes manual lewat keyboard

Tekan tombol berikut di jendela aplikasi untuk mencoba tampilan tanpa data asli.

| Tombol | Aksi |
| --- | --- |
| `1`–`7` | Ganti ekspresi mata |
| `B` | Kartu Bluetooth |
| `C` / `V` / `L` | Baterai normal / mengisi / rendah |
| `D` | Kartu perangkat contoh |
| `W` | Peringatan cuaca |
| `H` | Buka hub |
| `U` / `I` | HUD volume / kecerahan |
| `P` | Timer 3 detik |
| `←` `→` | Pindah halaman |

## Pemecahan masalah

**`Cannot find name 'path'` atau `'__dirname'` di `vite.config.ts`**
Pasang tipe Node dengan `npm i -D @types/node`, atau pakai path relatif (`"index.html"`) pada `rollupOptions.input`.

**`Port 1420 is already in use`**
Tauri membutuhkan port tetap. Hentikan proses yang memakai port 1420, lalu jalankan ulang.

**Build Rust pertama gagal di Linux**
Biasanya ada pustaka sistem yang belum terpasang. Periksa pesan error dan pasang paket yang disebut.

**Jendela tidak merespons klik di Windows**
Jendela *click-through* tidak menerima event mouse. Aplikasi menghitung hover dari posisi kursor global yang dikirim Rust lewat event `cursor`, jadi pastikan event itu berjalan.

## Skrip yang berguna

```bash
npm run tauri dev      # jalankan mode pengembangan
npm run tauri build    # buat installer
cargo check --manifest-path src-tauri/Cargo.toml   # periksa kode Rust tanpa build penuh
cargo clippy --manifest-path src-tauri/Cargo.toml  # lint kode Rust
```

## Lisensi

Tambahkan lisensi proyek Anda di sini.