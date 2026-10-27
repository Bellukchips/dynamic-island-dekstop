import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initNudge } from "./nudge";
import { loadFace, saveFace, startClock, type Face } from "./clock";
import { initCalendar, goToday, shiftMonth } from "./calendar";
import { initHubNav } from "./hub-nav";
import { initPrayer } from "./prayer";
import { getVersion } from "@tauri-apps/api/app";
import { loadRemoteUpdateConfig, type RemoteUpdateConfig } from "./firebase";
declare global {
  interface Window {
    __NOTCH_UPDATE_CONFIG__?: RemoteUpdateConfig;
  }
}
// ---------- konfigurasi (dari config.toml lewat Rust) ----------
type Appearance = {
  theme: string;      // "auto" | "dark" | "light" | "custom"
  background: string; // dipakai saat theme = "custom"
  text: string;       // kosong = otomatis kontras
  dark_bg: string;
  light_bg: string;
  accent: string;     // kosong = otomatis dari cover album
  default_mood: string; // ekspresi mata bawaan saat idle
  eye_theme: string; // skin visual mata: 10 pilihan, dari aurora hingga monochrome
};
type Cfg = {
  scale: number;
  pages: string[];
  timing: {
    hub_auto_ms: number; card_ms: number; hud_ms: number;
    hover_open_ms: number; hover_close_ms: number; sleep_after_s: number;
  };
  pomodoro: { focus_min: number; break_min: number; long_break_min: number; rounds: number };
  appearance: Appearance;
};
const FALLBACK: Cfg = {
  scale: 1,
  pages: ["media", "clock", "weather", "battery", "timer", "quick", "tools", "stats", "reminder", "notes", "clipboard", "shelf", "lyrics", "privacy", "prayer"],
  timing: { hub_auto_ms: 4000, card_ms: 3500, hud_ms: 1500, hover_open_ms: 150, hover_close_ms: 450, sleep_after_s: 60 },
  pomodoro: { focus_min: 25, break_min: 5, long_break_min: 15, rounds: 4 },
  appearance: { theme: "auto", background: "#000000", text: "", dark_bg: "#000000", light_bg: "#f5f5f7", accent: "", default_mood: "normal", eye_theme: "aurora" },
};
const rawCfg = (window as any).__CFG__ ?? {};
const CFG: Cfg = {
  ...FALLBACK,
  ...rawCfg,
  appearance: { ...FALLBACK.appearance, ...(rawCfg.appearance ?? {}) },
};
const T = CFG.timing;
// fitur tambahan (bukan halaman) juga diatur lewat daftar pages di config
const featureOn = (name: string) => CFG.pages.includes(name);
// indikator mic/kamera bisa dinyalakan/dimatikan langsung dari jendela pengaturan (tanpa restart)
let privacyOn = featureOn("privacy");

// Diisi setelah elemen hub tersedia. Memungkinkan perubahan daftar halaman dari Settings
// tanpa harus menghapus/membuat ulang jendela aplikasi.
let names: string[] = [];
let pageCount = 0;
let page = 0;
let setNavActive: (page: number) => void = () => {};
let rebuildHubPagesFn: ((pages: string[]) => void) | undefined;

// Elemen dari halaman yang dimatikan di config tidak ada di DOM (dibuang saat startup).
// Kembalikan elemen cadangan yang terlepas dari dokumen: operasi padanya tidak berefek, tapi kode di
// level modul tidak crash. Tanpa ini satu halaman yang dimatikan (mis. timer) menghentikan SELURUH
// sisa file, termasuk tombol Quick, clipboard, indikator privasi, lirik, dan shelf.
const missing = new Map<string, HTMLElement>();
const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el) return el;
  let stub = missing.get(id);
  if (!stub) { stub = document.createElement("div"); missing.set(id, stub); }
  return stub;
};
const notch = $("notch");
// Pengaman: #notch overflow:hidden tidak boleh tergulir (mis. oleh scrollIntoView / fokus input),
// karena isi pil akan bergeser keluar dan terlihat kosong.
notch.addEventListener("scroll", () => { notch.scrollTop = 0; notch.scrollLeft = 0; });
const eyes = document.querySelector<HTMLElement>(".eyes")!;
const eyeEls = document.querySelectorAll<HTMLElement>(".eye");
const isWin = navigator.userAgent.includes("Windows");

// ---------- state bersama ----------
type View = "bt" | "dev" | "hub" | "hud" | "lyr" | "cal" | "rem" | "prayerAlert" | "update";
let override: View | null = null;
let playing = false;
let hideTimer: number | undefined;
let lowBattery = false;
let keepAwake = false;

let inside = false;
let insideSince = 0;
let hubByHover = false;
let closeAt = 0;
let settleUntil = 0;
let holdHover = false; // setelah drop, jangan langsung buka hub selama kursor masih di atas notch

// posisi notch (piksel logis, titik tengah x & sisi atas y). Dideklarasikan di sini supaya
// semua fungsi di bawah bisa memakainya tanpa soal urutan.
let currentCx = -1;
let currentTy = 0;

// Wajah notch saat tidak ada kartu/musik: mata ("eyes") atau jam + tanggal ("clock").
// Berganti ketika hover dilepas (hub menutup) dan halaman yang terakhir dilihat adalah halaman jam.
let clockOn = featureOn("clock");
let idleFace: Face = clockOn ? loadFace() : "eyes";

// ---------- ukuran (dikalikan skala dari config) ----------
// Ukuran view = ukuran pil notch. Jendela native sendiri berukuran TETAP (lihat WIN_BASE).
const BASE_SIZES: Record<string, [number, number]> = {
  idle: [150, 28],
  compact: [250, 40],
  compactLyrics: [360, 40],
  edgeIdle: [80, 80],
  edgeMedia: [80, 120],
  bottomIdle: [100, 44],
  bottomMedia: [140, 60],
  hub: [580, 202],
  bt: [360, 80],
  dev: [360, 80],
  rem: [360, 80],
  prayerAlert: [360, 80],
  hud: [320, 60],
  update: [460, 104],

  lyr: [420, 230],
  clock: [240, 28],
  cal: [420, 336],
};
const BASE_HIT: Record<string, [number, number]> = {
  idle: [130, 24],
  compact: [230, 34],
  compactLyrics: [340, 34],
  edgeIdle: [60, 80],
  edgeMedia: [60, 120],
  bottomIdle: [80, 44],
  update: [460, 104],

  bottomMedia: [120, 60],
  hub: [560, 242], // mencakup tombol pusatkan yang mengambang di bawah hub
  bt: [340, 74],
  dev: [340, 74],
  rem: [340, 74],
  prayerAlert: [340, 74],
  hud: [300, 52],
  lyr: [400, 268], // mencakup tombol pusatkan di bawah
  clock: [220, 24],
  cal: [400, 360],
};
const scaleMap = (m: Record<string, [number, number]>) =>
  Object.fromEntries(
    Object.entries(m).map(([k, [w, h]]) => [k, [Math.round(w * CFG.scale), Math.round(h * CFG.scale)]])
  ) as Record<string, [number, number]>;

const SIZES = scaleMap(BASE_SIZES); // ukuran view (jendela + 10px telinga tiap sisi)
const HIT = scaleMap(BASE_HIT);     // ukuran PIL (area klik)
document.documentElement.style.setProperty("--s", String(CFG.scale));

// ---------- tema / warna (dari [appearance] di config.toml) ----------
const hexRgb = (h: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((h ?? "").trim());
  if (!m) return null;
  let v = m[1];
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luma = (c: number[]) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
const fixedAccent = () => hexRgb(CFG.appearance.accent) !== null;

const osLight = matchMedia("(prefers-color-scheme: light)");
const EYE_THEMES = ["aurora", "neon", "pastel", "pixel", "holo", "ember", "ocean", "sakura", "cyber", "monochrome"] as const;
function applyEyeTheme() {
  const requested = (CFG.appearance.eye_theme || "aurora").toLowerCase();
  eyes.dataset.eyeTheme = (EYE_THEMES as readonly string[]).includes(requested) ? requested : "aurora";
}

function applyTheme() {
  const a = CFG.appearance;
  const light = a.theme === "light" || (a.theme === "auto" && osLight.matches);
  const bgHex = a.theme === "custom" ? a.background : light ? a.light_bg : a.dark_bg;
  const bg = hexRgb(bgHex) ?? [0, 0, 0];
  const fg = hexRgb(a.text) ?? (luma(bg) > 0.55 ? [17, 17, 17] : [255, 255, 255]);

  const st = document.documentElement.style;
  st.setProperty("--bg", `rgb(${bg.join(",")})`);
  st.setProperty("--fg", `rgb(${fg.join(",")})`);
  st.setProperty("--fg-rgb", fg.join(","));
  const acc = hexRgb(a.accent);
  if (acc) st.setProperty("--accent", acc.join(", "));
  else st.removeProperty("--accent");
}
applyTheme();
applyEyeTheme();
osLight.addEventListener("change", applyTheme); // ikut berubah saat tema OS diganti

// ukuran langsung berubah tanpa restart
function applyScale(v: number) {
  CFG.scale = Math.min(1.5, Math.max(0.5, v));
  Object.assign(SIZES, scaleMap(BASE_SIZES));
  Object.assign(HIT, scaleMap(BASE_HIT));
  syncHubDynamicHeight();
  document.documentElement.style.setProperty("--s", String(CFG.scale));
  lastView = ""; // paksa ukuran jendela & area klik dihitung ulang
  void syncWindow();
  render();
}

// dari jendela pengaturan: pratinjau langsung / hasil simpan
listen<{ appearance?: Appearance; scale?: number; pages?: string[] }>("config-changed", (e) => {
  const p = e.payload;
  if (!p) return;
  if (p.appearance) {
    const moodChanged = p.appearance.default_mood !== undefined &&
      p.appearance.default_mood !== CFG.appearance.default_mood;
    // Gabungkan supaya event pengaturan parsial tidak menghapus properti appearance lain.
    CFG.appearance = { ...CFG.appearance, ...p.appearance };
    applyTheme();
    applyEyeTheme();
    if (moodChanged) updateBase();
  }
  if (typeof p.scale === "number" && p.scale !== CFG.scale) applyScale(p.scale);
  // Perubahan halaman dipratinjau langsung dari Settings. Jangan membuang elemen DOM:
  // simpan semua halaman lalu tampilkan/urutkan yang aktif agar halaman bisa diaktifkan lagi.
  if (Array.isArray(p.pages)) {
    const nextPages = p.pages.filter((name): name is string => typeof name === "string");
    const pagesChanged = nextPages.length !== CFG.pages.length ||
      nextPages.some((name, i) => name !== CFG.pages[i]);
    if (pagesChanged) {
      const clockWasOn = clockOn;
      CFG.pages = [...nextPages];
      clockOn = featureOn("clock");
      if (!clockOn && idleFace === "clock") {
        idleFace = "eyes";
      } else if (!clockWasOn && clockOn) {
        idleFace = loadFace();
      }
      rebuildHubPagesFn?.(CFG.pages);
    }

    const on = CFG.pages.includes("privacy");
    if (on !== privacyOn) {
      privacyOn = on;
      paintPrivacy();
    }
  }
});

// ---------- jendela berukuran tetap + penempatan notch di dalamnya ----------
const BOTTOM_TY = 100000; // ty sangat besar = menempel di dasar layar (di-clamp oleh Rust)
const isBottomTy = (ty: number) => ty >= BOTTOM_TY / 2;
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

// Jendela native berukuran TETAP (tidak pernah di-resize) -> tidak ada getaran dari resize native.
const WIN_BASE: [number, number] = [600, 336];
const winLogical = (): [number, number] => [
  Math.round(WIN_BASE[0] * CFG.scale),
  Math.round(WIN_BASE[1] * CFG.scale),
];
let MON = { x: 0, y: 0, w: window.screen.width, h: window.screen.height };
let shellOx = 0, shellOy = 0;

// geser notch di dalam jendela (hanya perlu saat posisi bebas dekat tepi, supaya view lebar tidak keluar layar)
function placeShell(view?: string) {
  const [W, H] = winLogical();
  const v = view ?? notch.dataset.view ?? "idle";
  const [vw, vh] = SIZES[v] ?? SIZES.idle;
  const left = notch.classList.contains("is-edge-left");
  const right = notch.classList.contains("is-edge-right");
  const bottom = notch.classList.contains("is-bottom");
  let ox = 0, oy = 0;
  if (currentCx !== -1) {
    if (!left && !right) {
      const winCx = clamp(currentCx, MON.x + W / 2, MON.x + MON.w - W / 2);
      const want = clamp(currentCx, MON.x + vw / 2, MON.x + MON.w - vw / 2);
      ox = want - winCx;
    }
    if (!bottom) {
      const winTy = clamp(currentTy, MON.y, MON.y + MON.h - H);
      const wantTy = Math.min(currentTy, MON.y + MON.h - vh);
      oy = wantTy - winTy;
    }
  }
  // Posisi melayang (termasuk SAAT drag): beri jarak dari tepi atas supaya hub tidak menempel.
  // Jarak dibatasi sisa ruang jendela agar view tinggi (kalender) tidak terpotong.
  if (notch.classList.contains("is-floating")) {
    const gap = Math.round(14 * CFG.scale);
    oy += Math.max(0, Math.min(gap, H - (oy + vh)));
  }

  shellOx = ox;
  shellOy = oy;
  const shell = $("shell");
  shell.style.setProperty("--ox", `${ox}px`);
  shell.style.setProperty("--oy", `${oy}px`);
}

// area klik pil dalam koordinat jendela
function hitRect(view: string) {
  const [W, H] = winLogical();
  const [hw, hh] = HIT[view] ?? HIT.idle;
  const left = notch.classList.contains("is-edge-left");
  const right = notch.classList.contains("is-edge-right");
  const bottom = notch.classList.contains("is-bottom");
  const x = left ? 0 : right ? W - hw : (W - hw) / 2 + shellOx;
  const y = bottom ? H - hh : shellOy;
  return { x: Math.round(x), y: Math.round(y), w: hw, h: hh };
}
function setHit(view: string) {
  const r = hitRect(view);
  invoke("set_hit_area", { x: r.x, y: r.y, w: r.w, h: r.h });
}

async function syncWindow() {
  // Ambil geometri monitor dari sisi Rust (jika tersedia)
  try {
    MON = await invoke<typeof MON>("notch_monitor");
  } catch {
    // Fallback: pakai ukuran layar bawaan
  }

  // Jika posisi notch belum diatur (-1), default ke tengah atas monitor
  if (currentCx === -1) {
    currentCx = MON.x + Math.round(MON.w / 2);
  }

  const [w, h] = winLogical();
  try {
    await invoke("set_size", { w, h });
  } catch (e) {
    console.error(e);
  }
  updatePositionUI(notch.classList.contains("is-custom-pos"), currentTy, currentCx);
}

// ---------- view: idle / compact / hub / bt / dev / hud / rem ----------
let lastView = "";
let appliedView = ""; // view yang area kliknya sudah selesai diterapkan
let sizeRequestId = 0;
let lastSizeRequestAt = 0;

function applySize(view: string, previousView = appliedView || view) {
  const requestId = ++sizeRequestId;
  lastSizeRequestAt = Date.now();
  const [w, h] = SIZES[view];
  const [oldW, oldH] = SIZES[previousView] ?? [w, h];
  const isExpanding = w >= oldW && h >= oldH;
  const stillCurrent = () => requestId === sizeRequestId && lastView === view;

  placeShell(view);
  const finish = () => {
    if (!stillCurrent()) return;
    setHit(view);
    appliedView = view;
  };

  // Membuka: hitbox besar langsung dipasang. Menutup: tunggu animasi CSS selesai.
  if (isExpanding) { finish(); return; }

  let fired = false;
  const go = () => {
    if (fired) return;
    fired = true;
    notch.removeEventListener("transitionend", onEnd);
    clearTimeout(fallback);
    finish();
  };
  const onEnd = (e: TransitionEvent) => {
    if (e.target === notch && (e.propertyName === "height" || e.propertyName === "width")) go();
  };
  notch.addEventListener("transitionend", onEnd);
  const fallback = window.setTimeout(go, 450);
}

function render() {
  const hasCompactLyrics = playing && lyState === "ok" && !!ly?.lines.length;
  const atSide = notch.classList.contains("is-edge-left") || notch.classList.contains("is-edge-right");
  const atBottom = notch.classList.contains("is-bottom");
  // Saat pointer baru masuk, tahan state mini sampai hover delay terpenuhi.
  // Dengan begitu expand langsung ke hub, bukan lewat tampilan horizontal perantara.
  const hoverPending = inside && Date.now() - insideSince < T.hover_open_ms;
  const bubble = (atSide || atBottom) && !override && !isDraggingWindow &&
    (!inside || hoverPending || holdHover);
  const view = override ?? (
    bubble
      ? (atSide ? (playing ? "edgeMedia" : "edgeIdle") : (playing ? "bottomMedia" : "bottomIdle"))
      : playing ? (hasCompactLyrics ? "compactLyrics" : "compact")
        : idleFace === "clock" ? "clock" : "idle"
  );
  notch.dataset.view = view;
  notch.dataset.playing = String(playing);

  if (view !== lastView) {
    // Catat view asal agar saat collapse hitbox lama bisa dipertahankan hingga akhir.
    const previousView = appliedView || lastView || view;
    // Selama animasi berlangsung, tepi notch bisa menyapu di bawah kursor dan memicu
    // mouseenter/mouseleave berkali-kali. settleUntil dipakai untuk mengabaikan perubahan
    // hover itu (lihat setInside) sampai animasi selesai.
    settleUntil = Date.now() + 400;
    lastView = view;
    appliedView = "";

    applySize(view, previousView);
  }
}

// pengaman: kalau area klik tidak cocok dengan view saat ini, terapkan ulang
setInterval(() => {
  if (lastView && appliedView !== lastView && Date.now() - lastSizeRequestAt > 2500) {
    applySize(lastView);
  }
}, 1500);

// true selama pengguna sedang mengetik di kolom teks dalam notch (jangan tutup walau kursor keluar)
function typing(): boolean {
  const a = document.activeElement;
  return !!a && document.hasFocus() && notch.contains(a) &&
    (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
}

function expand(view: View, ms = 3000) {
  if (override === "rem" && view !== "rem") return; // pengingat aktif tidak boleh tertimpa
  override = view;
  render();
  clearTimeout(hideTimer);
  if (ms > 0) {
    hideTimer = window.setTimeout(() => {
      if (view === "hub" && (inside || typing())) return;
      override = null;
      hubByHover = false;
      render();
    }, ms);
  }
}
function collapse() {
  // hub yang dibuka/ditahan pengguna (hover atau klik) lalu dilepas: ingat halaman terakhir.
  // Di halaman jam -> notch berganti dari mata ke jam + tanggal; di halaman lain -> kembali ke mata.
  // Hub otomatis (lagu baru, cuaca, timer) tidak mengubah apa-apa.
  const byUser = (override === "hub" || override === "cal") && hubByHover;
  clearTimeout(hideTimer);
  override = null;
  hubByHover = false;
  closeAt = 0;
  if (byUser && clockOn) {
    idleFace = names[page] === "clock" ? "clock" : "eyes";
    saveFace(idleFace);
  }
  render();
}

// ---------- mood: dasar + sementara ----------
type Mood = "normal" | "happy" | "sleepy" | "surprised" | "angry" | "love" | "suspicious" | "sad";
const MOODS: Mood[] = ["normal", "happy", "sleepy", "surprised", "angry", "love", "suspicious", "sad"];
// ekspresi bawaan saat idle (tidak tidur, tidak memutar lagu), bisa diatur di pengaturan
const defaultMood = (): Mood => {
  const m = CFG.appearance.default_mood as Mood;
  return MOODS.includes(m) ? m : "normal";
};
let baseMood: Mood = defaultMood();
let tempTimer: number | undefined;
let sleeping = false;
let lastActivity = Date.now();

const applyMood = (m: Mood) => { eyes.dataset.mood = m; };
// Terapkan mood bawaan sejak awal, tanpa menunggu interval update pertama.
applyMood(baseMood);

export function setBase(m: Mood) {
  baseMood = m;
  if (tempTimer === undefined) applyMood(m);
}
export function flash(m: Mood, ms = 1500) {
  applyMood(m);
  clearTimeout(tempTimer);
  tempTimer = window.setTimeout(() => { tempTimer = undefined; applyMood(baseMood); }, ms);
}

function updateBase() {
  const hour = new Date().getHours();
  const idleLong = Date.now() - lastActivity > T.sleep_after_s * 1000;
  const night = hour >= 0 && hour < 5;
  // Keep awake aktif -> mata tidak mengantuk
  const shouldSleep = (idleLong || night) && !keepAwake;

  if (sleeping && !shouldSleep) flash("surprised", 900);
  sleeping = shouldSleep;

  setBase(shouldSleep || lowBattery ? "sleepy" : playing ? "happy" : defaultMood());
}
setInterval(updateBase, 3000);

function markActive() { lastActivity = Date.now(); if (sleeping) updateBase(); }
document.addEventListener("mousemove", markActive);
document.addEventListener("keydown", markActive);

// ---------- hub: halaman yang bisa digeser ----------
const pagesEl = $("pages");
const track = $("track");
const dotsEl = $("dots");

// Simpan semua page di DOM dan hanya sembunyikan yang nonaktif. Dengan begitu Settings bisa
// mengaktifkan halaman lagi saat preview tanpa mengharuskan aplikasi membangun DOM ulang.
const allHubPages = [...track.querySelectorAll<HTMLElement>(".page")];
const pageOf = (n: string) => Math.max(0, names.indexOf(n));
// membuka hub dari wajah jam: mulai di halaman jam, supaya melepas hover tanpa menggeser tetap menjaga jam
const homePage = () => (clockOn && idleFace === "clock" ? pageOf("clock") : page);

function rebuildHubPages(enabledPages: string[]) {
  const previousName = names[page];
  const validNames = [...new Set(enabledPages.filter((name) =>
    allHubPages.some((el) => el.dataset.page === name)
  ))];

  // Jangan biarkan hub tanpa halaman ketika pengguna sedang mengubah checkbox di Settings.
  if (validNames.length === 0) {
    const fallback = allHubPages.find((el) => el.dataset.page === "media") ?? allHubPages[0];
    if (fallback?.dataset.page) validNames.push(fallback.dataset.page);
  }

  const active = new Set(validNames);
  for (const el of allHubPages) {
    if (active.has(el.dataset.page ?? "")) el.style.removeProperty("display");
    else el.style.display = "none";
  }

  // Urutan slide harus sama dengan daftar dari config.toml; halaman nonaktif ditempatkan di belakang.
  for (const name of validNames) {
    const el = allHubPages.find((candidate) => candidate.dataset.page === name);
    if (el) track.appendChild(el);
  }
  for (const el of allHubPages) {
    if (!active.has(el.dataset.page ?? "")) track.appendChild(el);
  }

  names = validNames;
  pageCount = names.length;
  dotsEl.replaceChildren();
  for (let i = 0; i < pageCount; i++) {
    const d = document.createElement("span");
    d.className = "dot";
    d.addEventListener("click", (e) => { e.stopPropagation(); setPage(i); });
    dotsEl.appendChild(d);
  }

  // initHubNav mengganti item lama, jadi checkbox preview berulang tidak membuat ikon duplikat.
  setNavActive = initHubNav(names, (i) => setPage(i));
  const priorIndex = previousName ? names.indexOf(previousName) : -1;
  page = priorIndex >= 0 ? priorIndex : Math.min(Math.max(page, 0), Math.max(0, pageCount - 1));
  setPage(page);
}

rebuildHubPagesFn = rebuildHubPages;
rebuildHubPages(CFG.pages);

function setPage(i: number) {
  page = Math.max(0, Math.min(pageCount - 1, i));
  track.style.setProperty("--page", String(page));
  track.style.setProperty("--drag", "0px");
  dotsEl.querySelectorAll(".dot").forEach((d, n) => d.classList.toggle("active", n === page));
  setNavActive(page);
  if (names[page] !== "notes" && notch.classList.contains("notes-expanded")) {
    setNotesExpanded(false);
  }
  if (names[page] === "quick" || names[page] === "tools") refreshQuick();
  if (names[page] === "clipboard") refreshClip();
  if (names[page] === "shelf") refreshShelf();
  if (names[page] === "reminder") refreshReminders();
  if (names[page] === "notes") refreshNotes();
}

function openHub(p: number, ms = 0) {
  if (override === "rem") return; // pengingat aktif tidak boleh tertimpa hub
  setPage(p);
  hubByHover = ms === 0;
  closeAt = 0;
  expand("hub", ms);
}

// geser dengan drag mouse
let startX = 0, dx = 0, dragging = false, moved = false;

// Geser halaman dengan drag mouse dimatikan: drag body sekarang memindahkan notch.
// Ganti halaman lewat scroll/touchpad, ikon di bar atas, atau tombol ← →.
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  dx = e.clientX - startX;
  if (Math.abs(dx) > 6) moved = true;
  const atEdge = (page === 0 && dx > 0) || (page === pageCount - 1 && dx < 0);
  track.style.setProperty("--drag", `${atEdge ? dx * 0.3 : dx}px`);
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  track.classList.remove("dragging");
  if (dx < -50) setPage(page + 1);
  else if (dx > 50) setPage(page - 1);
  else setPage(page);
  dx = 0;
  setTimeout(() => { moved = false; }, 0);
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);
pagesEl.addEventListener("click", (e) => { if (moved) e.stopPropagation(); }, true);

// geser dengan scroll mouse / touchpad
let wheelLock = false;
notch.addEventListener("wheel", (e) => {
  if (notch.dataset.view !== "hub") return;
  if ((e.target as HTMLElement).closest(".clip-list, .nt-pv-body, .nt-list")) return; // biarkan daftar/preview di-scroll
  if ((e.target as HTMLElement).closest(".nv-list")) return; // nav ikon boleh di-scroll sendiri
  const sh = (e.target as HTMLElement).closest<HTMLElement>(".sh-list"); // shelf: scroll mendatar
  if (sh && sh.scrollWidth > sh.clientWidth) { sh.scrollLeft += e.deltaY || e.deltaX; return; }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(d) < 10 || wheelLock) return;
  wheelLock = true;
  setTimeout(() => { wheelLock = false; }, 350);
  setPage(page + (d > 0 ? 1 : -1));
}, { passive: true });

// ---------- hover: dihitung dari posisi kursor ----------
// Listener harus aktif di Windows juga. Sebelumnya dibungkus `if (!isWin)`,
// sehingga pada Windows status `inside` tidak pernah diperbarui dan hub tidak terbuka.
let pointerX = -1;
let pointerY = -1;
let hoverSyncTimer: number | undefined;

const posBar = $("notch-pos-bar");
const rectHas = (x: number, y: number) => {
  const r = notch.getBoundingClientRect();
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  // tombol pusatkan mengambang di luar notch: kursor di atasnya (dan celah menuju ke sana) tetap dianggap "di dalam"
  if (inside && !isDraggingWindow) {
    const b = posBar.getBoundingClientRect();
    const top = Math.min(b.top, r.bottom), bottom = Math.max(b.bottom, r.top);
    return x >= b.left && x <= b.right && y >= top && y <= bottom;
  }
  return false;
};
// tombol pusatkan hanya muncul saat notch di-hover (di Windows :hover tidak andal karena jendela click-through)
const syncPosBar = () => $("shell").classList.toggle("pos-visible", inside && !isDraggingWindow);

function setInside(v: boolean) {
  // Hindari hover bolak-balik ketika ukuran native window sedang beranimasi.
  // Namun, jadwalkan sinkronisasi ulang agar status hover tidak tertinggal setelah animasi.
  if (Date.now() < settleUntil) {
    window.clearTimeout(hoverSyncTimer);
    hoverSyncTimer = window.setTimeout(() => {
      if (pointerX >= 0 && pointerY >= 0) {
        setInside(rectHas(pointerX, pointerY));
      }
    }, Math.max(25, settleUntil - Date.now() + 25));
    return;
  }
  if (v === inside) return;
  if (!v) holdHover = false;
  inside = v;
  insideSince = v ? Date.now() : 0;
  syncPosBar();
  if (v) flash("surprised", 900);
  render();
}

window.addEventListener("pointermove", (e) => {
  pointerX = e.clientX;
  pointerY = e.clientY;
  setInside(rectHas(pointerX, pointerY));
});
window.addEventListener("pointerup", (e) => {
  pointerX = e.clientX;
  pointerY = e.clientY;
  setInside(rectHas(pointerX, pointerY));
});
notch.addEventListener("mouseenter", () => setInside(true));
document.documentElement.addEventListener("mouseleave", () => setInside(false));
window.addEventListener("blur", () => setInside(false));

// watchdog: buka/tutup hub dengan hysteresis
setInterval(() => {
  const now = Date.now();
  if (dragging || isDraggingWindow || now < settleUntil) return;

  if (override === "hub" || override === "lyr" || override === "cal") {
    if (inside) {
      if (!hubByHover) { clearTimeout(hideTimer); hubByHover = true; }
      closeAt = 0;
    } else if (hubByHover) {
      if (typing()) { closeAt = 0; } // sedang mengetik: jangan tutup
      else if (!closeAt) closeAt = now + T.hover_close_ms;
      else if (now >= closeAt) { closeAt = 0; collapse(); }
    }
  } else {
    closeAt = 0;
    if (!override && inside && !holdHover && now - insideSince > T.hover_open_ms) openHub(homePage());
  }
}, 120);

// ---------- nonaktifkan klik kanan (menu bawaan webview) ----------
// fase capture: menu bawaan diblokir di mana pun; handler lain (mis. klik kanan item shelf) tetap jalan
window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// ---------- geser (drag) notch sesuka hati & reset ke tengah ----------
let isDraggingWindow = false;
let startScreenX = 0;
let startScreenY = 0;
let startCx = 0;
let startTy = 0;
let windowDragMoved = false;
let suppressClickUntil = 0;

function updatePositionUI(custom: boolean, topY: number, cx?: number) {
  if (cx !== undefined) currentCx = cx;
  currentTy = topY;

  const shell = $("shell");
  const bottom = custom && isBottomTy(topY);
  const topOffset = topY - MON.y;

  // sisi layar: cx sudah di-snap ke tepi monitor (zona snap 70px)
  let side: "left" | "right" | null = null;
  if (custom && !bottom && currentCx !== -1) {
    if (currentCx - MON.x <= 70) side = "left";
    else if (MON.x + MON.w - currentCx <= 70) side = "right";
  }

  // Saat sedang ditahan dan mendekati tepi atas, hentikan efek drag lebih awal.
  // Kalau menunggu sampai koordinat benar-benar tersnap, animasi scale masih aktif
  // selama beberapa frame dan telinga #shell tampak terpisah dari badan #notch.
  const topApproach = isDraggingWindow && !bottom && side === null &&
    topOffset > 8 && topOffset <= Math.round(96 * CFG.scale);
  const isFloating = custom && !bottom && topOffset > 8;

  notch.classList.toggle("is-custom-pos", custom);
  notch.classList.toggle("is-floating", isFloating);
  notch.classList.toggle("is-bottom", bottom);
  notch.classList.toggle("is-top-approach", topApproach);
  shell.classList.toggle("is-floating", isFloating);
  shell.classList.toggle("is-bottom", bottom);
  shell.classList.toggle("is-top-approach", topApproach);
  const changed =
    notch.classList.contains("is-edge-left") !== (side === "left") ||
    notch.classList.contains("is-edge-right") !== (side === "right");
  notch.classList.toggle("is-edge-left", side === "left");
  notch.classList.toggle("is-edge-right", side === "right");
  shell.classList.toggle("is-edge-left", side === "left");
  shell.classList.toggle("is-edge-right", side === "right");

  // Ketika magnet ke tepi atas, hentikan efek mengecil/memantul saat drag.
  // Telinga lengkung tetap terlihat, tetapi badan notch tidak membentuk celah di tengah.
  const topDocked = !bottom && !isFloating && topOffset <= 8 && side === null;
  notch.classList.toggle("is-top", topDocked);
  shell.classList.toggle("is-top", topDocked);

  placeShell();
  if (changed) render();
}

// Magnet ke tepi atas/bawah/kiri/kanan dengan histeresis lebar supaya tidak bolak-balik.
let lastSent = { cx: NaN, ty: NaN };
function snapPosition(rawCx: number, rawTy: number, curX: number, curY: number) {
  const L = MON.x, R = MON.x + MON.w, Tp = MON.y;
  // tepi bawah: pakai yang lebih kecil antara ukuran monitor dari Rust dan ukuran layar webview
  const B = MON.y + Math.min(MON.h, window.screen.height || MON.h);
  let cx = rawCx, ty = rawTy;

  const wasL = notch.classList.contains("is-edge-left");
  const wasR = notch.classList.contains("is-edge-right");
  const wasB = notch.classList.contains("is-bottom");
  const wasT = !wasB && !notch.classList.contains("is-floating");

  // Bawah ditentukan dari posisi KURSOR (kursor tidak bisa melewati tepi layar, jadi selalu tercapai).
  // Menghitung dari posisi pil gagal kalau titik pegang pil tidak sama dengan titik awal drag.
  const nearBottom = B - curY <= (wasB ? 90 : 48) || B - (rawTy + 28 * CFG.scale) <= (wasB ? 60 : 24);
  if (nearBottom) {
    ty = BOTTOM_TY;
    cx = rawCx; // di dasar layar: cx bebas, tidak ikut menjadi bubble sisi
  } else {
    if (rawTy - Tp <= (wasT ? 60 : 24)) ty = Tp;
    if (rawCx - L <= (wasL ? 110 : 70) || curX - L <= (wasL ? 90 : 40)) cx = L;
    else if (R - rawCx <= (wasR ? 110 : 70) || R - curX <= (wasR ? 90 : 40)) cx = R;
  }
  return { cx, ty };
}

async function startWindowDrag(e: PointerEvent, targetEl: HTMLElement) {
  if (e.button !== 0) return; // hanya klik kiri
  try {
    const pos = await invoke<[number, number]>("notch_start_move");
    const s = CFG.scale;
    startCx = notch.classList.contains("is-edge-left") ? MON.x + 30 * s
      : notch.classList.contains("is-edge-right") ? MON.x + MON.w - 30 * s
        : pos[0];
    startTy = isBottomTy(pos[1]) ? MON.y + MON.h - 28 * s : pos[1];
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    isDraggingWindow = true;
    syncPosBar();
    windowDragMoved = false;
    lastSent = { cx: NaN, ty: NaN };
    $("shell").classList.add("moving");
    notch.classList.add("is-dragging");
    targetEl.setPointerCapture(e.pointerId);
  } catch (err) {
    console.error("Gagal memulai drag window:", err);
  }
}

function onWindowPointerMove(e: PointerEvent) {
  if (!isDraggingWindow) return;
  const dx = e.screenX - startScreenX;
  const dy = e.screenY - startScreenY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    windowDragMoved = true;
  }
  if (windowDragMoved) {
    const s = snapPosition(startCx + dx, startTy + dy, e.screenX, e.screenY);
    if (s.cx !== lastSent.cx || s.ty !== lastSent.ty) { // jangan kirim ulang yang sama
      lastSent = s;
      invoke("notch_move_to", { cx: s.cx, ty: s.ty });
      updatePositionUI(true, s.ty, s.cx);
    }
    setBase("love");
  }
}

function onWindowPointerUp(e: PointerEvent, targetEl: HTMLElement) {
  if (!isDraggingWindow) return;
  isDraggingWindow = false;
  syncPosBar();
  notch.classList.remove("is-dragging");
  $("shell").classList.remove("moving");
  if (windowDragMoved) holdHover = true;
  try {
    targetEl.releasePointerCapture(e.pointerId);
  } catch { }
  if (windowDragMoved) {
    suppressClickUntil = Date.now() + 350;
    insideSince = Date.now();
    invoke("notch_end_move", { save: true });
  } else {
    invoke("notch_end_move", { save: false });
  }

  // Drag selesai: hitung ulang posisi melayang dan area klik supaya tetap sinkron.
  if (windowDragMoved) {
    updatePositionUI(true, currentTy, currentCx);
    setHit(notch.dataset.view ?? "idle");
  }

  // Hitung target sekali lagi agar notch langsung masuk mode tepi yang benar.
  render();
}

async function resetPosition() {
  try {
    await invoke("notch_reset_position");
    updatePositionUI(false, 0, -1);
    flash("happy", 1200);
  } catch (err) {
    console.error("Gagal reset posisi notch:", err);
  }
}

// Drag langsung dari body notch di SEMUA view (idle, compact, bubble, hub, lirik, kalender, kartu).
// Kontrol interaktif dikecualikan supaya tetap bisa diklik / diketik.
const NO_DRAG = "button, input, textarea, select, a, .dot";
notch.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest(NO_DRAG)) return;
  startWindowDrag(e, notch);
});
notch.addEventListener("pointermove", onWindowPointerMove);
notch.addEventListener("pointerup", (e) => onWindowPointerUp(e, notch));
notch.addEventListener("pointercancel", (e) => onWindowPointerUp(e, notch));

// Tombol reset posisi
$("notch-reset-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  resetPosition();
});
$("q-reset-pos").addEventListener("click", (e) => {
  e.stopPropagation();
  resetPosition();
});

// Dengarkan perubahan posisi dari tray atau jendela pengaturan
listen<{ custom: boolean; x?: number; y?: number }>("position-changed", (e) => {
  const p = e.payload;
  updatePositionUI(p?.custom ?? false, p?.y ?? 0, p?.x);
});

// Inisialisasi status posisi saat startup
invoke<{ custom: boolean; x: number; y: number }>("notch_get_position")
  .then((p) => {
    if (p.custom) {
      // Posisi kustom: pakai cx & ty yang tersimpan
      updatePositionUI(true, p.y, p.x);
    } else {
      // Posisi default: pusatkan notch di tengah atas monitor (MON.w / 2)
      const centerCx = MON.x + Math.round(MON.w / 2);
      updatePositionUI(false, 0, centerCx);
    }
  })
  .catch(() => {
    // Fallback: pusatkan menggunakan screen.width
    const centerCx = Math.round(window.screen.width / 2);
    updatePositionUI(false, 0, centerCx);
  });

// ---------- klik notch ----------
let clicks: number[] = [];

notch.addEventListener("click", (e) => {
  if (Date.now() < suppressClickUntil) {
    e.stopPropagation();
    return;
  }
  const now = Date.now();
  clicks = clicks.filter((t) => now - t < 2000).concat(now);

  if (clicks.length >= 5) { flash("angry", 2000); clicks = []; }
  else flash("happy", 1200);

  // kartu pengingat (rem) tidak ditutup lewat klik: hanya lewat tombol Tunda / Selesai
  if (override === "bt" || override === "dev" || override === "hud" || override === "prayerAlert") collapse();
  else if (!override) openHub(homePage());
});
notch.addEventListener("dblclick", () => flash("love", 2500));

// ---------- kedip ----------
function blinkLoop() {
  const m = eyes.dataset.mood;
  if (m !== "love") {
    eyeEls.forEach((e) => e.classList.add("blink"));
    setTimeout(() => eyeEls.forEach((e) => e.classList.remove("blink")), 130);
  }
  setTimeout(blinkLoop, (m === "sleepy" ? 1500 : 2500) + Math.random() * 3500);
}
blinkLoop();

// ---------- arah pandangan + posisi kursor dari Rust ----------
let lastCursorMove = 0;
function look(dx: number, dy: number) {
  const max = 6;
  const dist = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, dist / 300);
  eyes.style.setProperty("--lx", `${(dx / dist) * max * k}px`);
  eyes.style.setProperty("--ly", `${Math.max(-1, Math.min(1, (dy / dist) * max * k))}px`);
}
let lastPos = { dx: 0, dy: 0 };
listen<{ dx: number; dy: number }>("cursor", (e) => {
  const { dx, dy } = e.payload;
  if (Math.hypot(dx - lastPos.dx, dy - lastPos.dy) > 2) {
    lastCursorMove = Date.now();
    markActive();
  }
  lastPos = { dx, dy };

  const v = notch.dataset.view ?? "idle";
  const hr = hitRect(v);
  const [WW] = winLogical();
  look(dx - (hr.x + hr.w / 2 - WW / 2), dy - hr.y); // mata menghadap kursor dari tengah notch, bukan tengah jendela

  // Windows: hover dihitung dari posisi global (jendela click-through tidak menerima event mouse)
  if (isWin) {
    const px = WW / 2 + dx, py = dy + 12;
    setInside(px >= hr.x && px <= hr.x + hr.w && py >= hr.y && py <= hr.y + hr.h);
  }
});
setInterval(() => {
  if (Date.now() - lastCursorMove > 5000) look((Math.random() - 0.5) * 300, (Math.random() - 0.5) * 60);
}, 2500);

// ---------- warna adaptif dari artwork ----------
function accentFrom(img: HTMLImageElement) {
  if (fixedAccent()) return; // aksen tetap dari config
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const s = (mx - mn) / (mx || 1);
      const wt = s * s + 0.05;
      r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
    }
    r /= w; g /= w; b /= w;
    const k = 210 / (Math.max(r, g, b) || 1);
    document.documentElement.style.setProperty(
      "--accent", `${Math.min(255, r * k) | 0}, ${Math.min(255, g * k) | 0}, ${Math.min(255, b * k) | 0}`
    );
  } catch { /* artwork lintas domain tidak bisa dibaca, pakai warna default */ }
}

// ---------- media ----------
type Media = { active: boolean; title: string; artist: string; playing: boolean; position: number; length: number };
const artEl = $("art") as HTMLImageElement;
const cArtEl = $("c-art") as HTMLImageElement;
const lyArtEl = $("ly-art") as HTMLImageElement;
let lastTitle = "";

// Satu baris lirik di compact view, ditempatkan di antara cover album dan equalizer.
const compactLyrics = document.createElement("div");
compactLyrics.id = "c-lyric";
compactLyrics.className = "c-lyric";
compactLyrics.setAttribute("aria-live", "polite");
const compactLayer = document.querySelector<HTMLElement>(".l-compact");
const compactBars = compactLayer?.querySelector<HTMLElement>(".bars");
if (compactLayer && compactBars) {
  compactLayer.insertBefore(compactLyrics, compactBars);
}

// Tampilan ringkas di sisi/dasar layar: hanya cover album berbentuk disc berputar.
const edgeDisc = document.createElement("div");
edgeDisc.className = "edge-disc";
edgeDisc.setAttribute("aria-hidden", "true");
const edgeDiscImg = document.createElement("img");
edgeDiscImg.alt = "";
edgeDisc.appendChild(edgeDiscImg);
notch.appendChild(edgeDisc);

// gambar bawaan saat tidak ada media / tidak ada artwork
const DEFAULT_ART =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3a4a"/><stop offset="1" stop-color="#18181f"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><g fill="none" stroke="#8e8e9a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M40 62V32l24-6v30"/><circle cx="34" cy="62" r="6"/><circle cx="58" cy="56" r="6"/></g></svg>`
  );
let artIsDefault = false;

let artToken = 0; // membatalkan pengecilan gambar yang tertunda kalau sudah ada yang lebih baru
function showDefaultArt() {
  if (artIsDefault) return;
  artToken++;
  artIsDefault = true;
  artEl.onload = null;
  for (const el of [artEl, cArtEl, lyArtEl]) el.removeAttribute("data-icon");
  artEl.src = DEFAULT_ART;
  cArtEl.src = DEFAULT_ART;
  lyArtEl.src = DEFAULT_ART;
  edgeDiscImg.src = DEFAULT_ART;
  artEl.style.visibility = cArtEl.style.visibility = "visible";
  if (!fixedAccent()) document.documentElement.style.removeProperty("--accent"); // kembali ke warna bawaan
}
// Ikon aplikasi (mis. logo Chrome) sering datang sebagai tile hitam. Kalau gambar berupa objek
// di tengah dengan latar hampir hitam yang menyambung dari tepi, latar itu dibuang (flood-fill)
// lalu objeknya diperbesar. Cover album biasa (tepi tidak seragam gelap / isi memenuhi gambar) tidak disentuh.
function stripBlackTile(c: HTMLCanvasElement): boolean {
  const n = c.width;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const im = ctx.getImageData(0, 0, n, n);
  const d = im.data;
  const luma = (p: number) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  const isDark = (k: number) => d[k * 4 + 3] < 40 || luma(k * 4) < 36;

  let edgeDark = 0; // hampir seluruh tepi harus gelap
  for (let i = 0; i < n; i++) {
    edgeDark += +isDark(i) + +isDark((n - 1) * n + i) + +isDark(i * n) + +isDark(i * n + n - 1);
  }
  if (edgeDark < n * 4 * 0.92) return false;

  const gone = new Uint8Array(n * n);
  const stack: number[] = [];
  const push = (k: number) => { if (!gone[k] && isDark(k)) { gone[k] = 1; stack.push(k); } };
  for (let i = 0; i < n; i++) { push(i); push((n - 1) * n + i); push(i * n); push(i * n + n - 1); }
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % n, y = (k - x) / n;
    if (x > 0) push(k - 1);
    if (x < n - 1) push(k + 1);
    if (y > 0) push(k - n);
    if (y < n - 1) push(k + n);
  }

  let x0 = n, y0 = n, x1 = -1, y1 = -1, removed = 0;
  for (let k = 0; k < n * n; k++) {
    if (gone[k]) { removed++; continue; }
    const x = k % n, y = (k - x) / n;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return false;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // harus objek yang berdiri di tengah dengan margin, bukan gambar yang memenuhi bingkai
  if (removed < n * n * 0.12 || bw > n * 0.88 || bh > n * 0.88) return false;
  if (Math.abs(cx - n / 2) > n * 0.1 || Math.abs(cy - n / 2) > n * 0.1) return false;

  for (let k = 0; k < n * n; k++) {
    const p = k * 4;
    if (gone[k]) { d[p + 3] = 0; continue; }
    const x = k % n, y = (k - x) / n;
    const edge = (x > 0 && gone[k - 1]) || (x < n - 1 && gone[k + 1]) || (y > 0 && gone[k - n]) || (y < n - 1 && gone[k + n]);
    if (edge) { // lunturkan piksel gelap di pinggir objek supaya tidak ada garis hitam
      const l = luma(p);
      if (l < 90) d[p + 3] = Math.round(255 * Math.max(0, Math.min(1, l / 90)));
    }
  }
  ctx.putImageData(im, 0, 0);

  const side = Math.ceil(Math.max(bw, bh) * 1.1); // perbesar objek supaya memenuhi kotak
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = n;
  tmp.getContext("2d")!.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, n, n);
  ctx.clearRect(0, 0, n, n);
  ctx.drawImage(tmp, 0, 0);
  return true;
}
// Cover album bisa beberapa MB (data URL) dan didekode penuh oleh webview, dua kali (hub + kartu kecil).
// Dikecilkan dulu ke 192px: string besar & bitmap besar langsung bisa dibuang dari memori.
const ART_PX = 192;
function showArt(src: string) {
  artIsDefault = false;
  const token = ++artToken;
  const img = new Image();
  img.onload = () => {
    if (token !== artToken) return; // sudah ada gambar yang lebih baru
    let small = src;
    let icon = false;
    try {
      const c = document.createElement("canvas");
      c.width = c.height = ART_PX;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext("2d")!.drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, ART_PX, ART_PX
      );
      icon = stripBlackTile(c);
      small = c.toDataURL("image/webp", 0.85); // webp menjaga transparansi (jpeg mengubahnya jadi hitam)
      c.width = c.height = 0; // lepaskan bitmap canvas
    } catch { /* gambar lintas domain tidak bisa dibaca canvas: pakai aslinya */ }
    for (const el of [artEl, cArtEl, lyArtEl]) el.toggleAttribute("data-icon", icon); // ikon aplikasi: tanpa tile gelap
    artEl.onload = () => accentFrom(artEl);
    artEl.src = small;
    cArtEl.src = small;
    lyArtEl.src = small;
    edgeDiscImg.src = small;
    artEl.style.visibility = cArtEl.style.visibility = "visible";
  };
  img.src = src;
}

showDefaultArt();

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

listen<Media>("media", (e) => {
  const m = e.payload;
  const wasPlaying = playing;
  playing = m.active && m.playing;

  $("m-title").textContent = m.active ? m.title || "Tanpa judul" : "Tidak ada media";
  $("m-artist").textContent = m.active ? m.artist : "Putar musik untuk memulai";
  $("ly-title").textContent = m.active ? m.title || "Tanpa judul" : "Tidak ada media";
  $("ly-artist").textContent = m.active ? m.artist : "";
  if (!m.active) showDefaultArt();
  $("m-progress").style.width = m.length > 0 ? `${(m.position / m.length) * 100}%` : "0%";
  $("t-pos").textContent = fmt(m.position);
  $("t-len").textContent = fmt(m.length);

  if (playing && m.title && m.title !== lastTitle) {
    if (!inside) openHub(pageOf("media"), T.hub_auto_ms);
    if (lastTitle) flash("surprised", 900);
  } else render();
  lastTitle = m.title;

  if (playing !== wasPlaying) updateBase();
  onMediaForLyrics(m);
});

listen<string | null>("media-art", (e) => {
  if (e.payload) showArt(e.payload);
  else showDefaultArt();
});

const control = (action: string) => (ev: Event) => { ev.stopPropagation(); invoke("media_control", { action }); };
$("m-prev").addEventListener("click", control("prev"));
$("m-toggle").addEventListener("click", control("toggle"));
$("m-next").addEventListener("click", control("next"));

// ---------- bluetooth ----------
type BtDev = { name: string; battery: number | null };

function paintBt(name: string, battery: number | null, connected: boolean) {
  $("bt-name").textContent = name;
  $("bt-sub").textContent = !connected
    ? "Disconnected"
    : battery != null ? `Connected · ${battery}%` : "Connected";
  $("bt-ring").style.setProperty("--pct", String(connected ? (battery ?? 100) : 0));
}

// tidak ada perangkat terhubung: jangan tampilkan teks contoh dari HTML
function paintBtNone() {
  $("bt-name").textContent = "Bluetooth";
  $("bt-sub").textContent = "Tidak ada perangkat";
  $("bt-ring").style.setProperty("--pct", "0");
}
paintBtNone();

// isi kartu dari keadaan nyata (termasuk perangkat yang sudah terhubung sebelum app dibuka)
async function refreshBt() {
  try {
    const list = await invoke<BtDev[]>("bt_list");
    if (list.length) paintBt(list[0].name, list[0].battery, true);
    else paintBtNone();
  } catch { paintBtNone(); }
}
refreshBt();
setTimeout(refreshBt, 4000); // pemantau butuh beberapa detik untuk pembacaan pertama

// dibuka manual (tombol B): tampilkan keadaan saat ini
async function openBtManual() {
  await refreshBt();
  hubByHover = false;
  expand("bt");
}

listen<{ name: string; battery: number | null; connected?: boolean }>("bluetooth", (e) => {
  const { name, battery } = e.payload;
  const connected = e.payload.connected !== false; // event lama tanpa field = terhubung
  paintBt(name, battery, connected);
  hubByHover = false;
  expand("bt", T.card_ms);
  if (connected) flash("happy", 2500);
});

// ---------- baterai ----------
let wasCharging: boolean | null = null;
function handleBattery(percent: number, charging: boolean) {
  if (wasCharging === false && charging) flash("love", 3000);
  wasCharging = charging;

  const low = percent <= 15 && !charging;
  if (low !== lowBattery) { lowBattery = low; updateBase(); }

  $("bat-pct").textContent = `${percent}%`;
  $("bat-sub").textContent = charging ? "Sedang mengisi" : low ? "Baterai rendah" : "Tidak mengisi";
  const fill = $("bat-fill");
  fill.style.width = `${percent}%`;
  fill.classList.toggle("low", low);
  fill.classList.toggle("charging", charging);
}
listen<{ percent: number; charging: boolean }>("battery", (e) =>
  handleBattery(e.payload.percent, e.payload.charging)
);

// ---------- perangkat colok / cabut ----------
const ICONS: Record<string, string> = {
  charger: `<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`,
  usb: `<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>`,
  usbc: `<rect x="4" y="9" width="16" height="6" rx="3"/><path d="M8 12h8"/>`,
  storage: `<rect x="3" y="14" width="18" height="7" rx="2"/><path d="M5 14l2-9h10l2 9"/><path d="M7 17.5h.01M11 17.5h6"/>`,
  keyboard: `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>`,
  mouse: `<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>`,
  audio: `<path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z"/>`,
  phone: `<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>`,
  camera: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
  mic: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`,
  printer: `<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/>`,
};
const LABELS: Record<string, string> = {
  charger: "Charger", usb: "USB", usbc: "USB Type-C", storage: "Penyimpanan",
  keyboard: "Keyboard", mouse: "Mouse", audio: "Audio", phone: "Ponsel",
  camera: "Kamera", mic: "Mikrofon", printer: "Printer",
};

function showDevice(kind: string, name: string, connected: boolean, sub?: string) {
  const icon = $("dev-icon");
  icon.dataset.kind = ICONS[kind] ? kind : "usb";
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] ?? ICONS.usb}</svg>`;
  icon.classList.toggle("off", !connected);
  $("dev-chip").classList.toggle("off", !connected);
  $("dev-chip").innerHTML = connected
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l18 18M18 6 6 18"/></svg>`;
  $("dev-name").textContent = name;
  $("dev-sub").textContent = sub ?? `${LABELS[kind] ?? "Perangkat"} · ${connected ? "Terhubung" : "Dilepas"}`;

  hubByHover = false;
  expand("dev", connected ? T.card_ms : 2000);

  icon.classList.remove("play");
  void icon.offsetWidth;
  if (connected) icon.classList.add("play");

  if (!connected) flash("surprised", 900);
  else flash(kind === "charger" ? "love" : "happy", 2500);
}

listen<{ kind: string; name: string; connected: boolean }>("device", (e) =>
  showDevice(e.payload.kind, e.payload.name, e.payload.connected)
);

// ---------- cuaca ----------
type Weather = {
  temp: number; feels: number; humidity: number;
  code: number; is_day: boolean; rain_in: number | null;
};

function describe(code: number, day: boolean): { kind: string; emoji: string; text: string } {
  if (code === 0) return day
    ? { kind: "clear", emoji: "☀️", text: "Cerah" }
    : { kind: "night", emoji: "🌙", text: "Cerah (malam)" };
  if (code <= 2) return { kind: day ? "clear" : "night", emoji: day ? "🌤️" : "☁️", text: "Cerah berawan" };
  if (code === 3) return { kind: "cloud", emoji: "☁️", text: "Mendung" };
  if (code <= 48) return { kind: "fog", emoji: "🌫️", text: "Berkabut" };
  if (code <= 57) return { kind: "rain", emoji: "🌦️", text: "Gerimis" };
  if (code <= 67 || (code >= 80 && code <= 82)) return { kind: "rain", emoji: "🌧️", text: "Hujan" };
  if (code >= 95) return { kind: "storm", emoji: "⛈️", text: "Badai petir" };
  return { kind: "cloud", emoji: "☁️", text: "Berawan" };
}

function showWeather(w: Weather, alert = false) {
  const d = describe(w.code, w.is_day);
  $("wx-icon").dataset.kind = d.kind;
  $("wx-emoji").textContent = d.emoji;
  $("wx-temp").textContent = `${Math.round(w.temp)}°`;
  $("wx-desc").textContent = alert && w.rain_in ? `Hujan ${w.rain_in} menit lagi` : d.text;
  $("wx-feels").textContent = `Terasa ${Math.round(w.feels)}°`;
  $("wx-hum").textContent = `Lembap ${Math.round(w.humidity)}%`;
}

listen<[Weather, boolean]>("weather", (e) => {
  const [w, alert] = e.payload;
  showWeather(w, alert);
  if (alert) {
    openHub(pageOf("weather"), 5000);
    flash("surprised", 1500);
  } else if (w.code === 0 && w.is_day) {
    flash("happy", 2000);
  }
});

// ---------- HUD volume / brightness ----------
const HUD_ICONS = {
  mute: `<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M23 9l-6 6M17 9l6 6"/>`,
  low: `<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>`,
  high: `<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
};

function showHud(kind: string, value: number, muted: boolean) {
  if (override === "rem") return; // jangan menimpa pengingat aktif
  if ((override === "hub" || override === "lyr" || override === "cal") && inside) return;

  const v = Math.max(0, Math.min(100, Math.round(value)));
  const icon =
    kind === "brightness" ? HUD_ICONS.sun
      : muted || v === 0 ? HUD_ICONS.mute
        : v < 50 ? HUD_ICONS.low
          : HUD_ICONS.high;

  $("hud-icon").innerHTML = icon;
  const fill = $("hud-fill");
  fill.style.width = `${v}%`;
  fill.classList.toggle("muted", muted);
  $("hud-val").textContent = muted ? "mute" : String(v);

  hubByHover = false;
  expand("hud", T.hud_ms);

  if (kind === "volume") {
    if (muted || v === 0) flash("sleepy", 1500);
    else if (v >= 90) flash("surprised", 1200);
    else flash("happy", 1000);
  } else {
    flash(v < 25 ? "sleepy" : "happy", 1200);
  }
}

listen<{ kind: string; value: number; muted: boolean }>("hud", (e) =>
  showHud(e.payload.kind, e.payload.value, e.payload.muted)
);

// ---------- timer / pomodoro ----------
type Phase = "focus" | "break" | "long";
const POM = CFG.pomodoro;
let phase: Phase = "focus";
let round = 1;
let running = false;
let endAt = 0;
const phaseLen = (p: Phase) => (p === "focus" ? POM.focus_min : p === "break" ? POM.break_min : POM.long_break_min) * 60;
let remaining = phaseLen("focus");

function renderPom() {
  if (!document.getElementById("pom-time")) return; // halaman timer dimatikan di config
  const m = Math.floor(remaining / 60), s = remaining % 60;
  $("pom-time").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  $("pom-label").textContent =
    phase === "focus" ? `Fokus · ronde ${round}/${POM.rounds}` : phase === "break" ? "Istirahat" : "Istirahat panjang";
  const total = phaseLen(phase);
  const fill = $("pom-fill");
  fill.style.width = `${((total - remaining) / total) * 100}%`;
  fill.classList.toggle("rest", phase !== "focus");

  // ikon play/pause diatur langsung supaya tidak ikut status media
  const t = $("pom-toggle");
  t.classList.toggle("running", running);
  t.querySelector<HTMLElement>(".i-play")!.style.display = running ? "none" : "block";
  t.querySelector<HTMLElement>(".i-pause")!.style.display = running ? "block" : "none";
}

function nextPhase(auto: boolean) {
  running = false;
  const finished = phase;
  if (phase === "focus") phase = round >= POM.rounds ? "long" : "break";
  else { if (phase === "long") round = 1; else round++; phase = "focus"; }
  remaining = phaseLen(phase);
  renderPom();

  if (auto) {
    // waktu habis: buka halaman timer dan beri tahu lewat mata
    hubByHover = false;
    openHub(pageOf("timer"), 6000);
    flash(finished === "focus" ? "love" : "surprised", 3000);
  }
}

setInterval(() => {
  if (!running) return;
  remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  renderPom();
  if (remaining <= 0) nextPhase(true);
}, 250);

const pomBtn = (id: string, fn: () => void) =>
  $(id).addEventListener("click", (e) => { e.stopPropagation(); fn(); renderPom(); });

pomBtn("pom-toggle", () => {
  running = !running;
  if (running) endAt = Date.now() + remaining * 1000;
});
pomBtn("pom-reset", () => { running = false; remaining = phaseLen(phase); });
pomBtn("pom-skip", () => nextPhase(false));
renderPom();

// ---------- kontrol cepat ----------
type Quick = {
  mic: boolean | null; wifi: boolean | null; bt: boolean | null;
  awake: boolean | null; dark: boolean | null;
};
type QKey = keyof Quick;
const qIds: Record<QKey, string> = {
  mic: "q-mic", wifi: "q-wifi", bt: "q-bt", awake: "q-awake", dark: "q-dark",
};
// [tidak didukung, on, off]
const qLabel: Record<QKey, [string, string, string]> = {
  mic: ["Mic", "Mic mati", "Mic aktif"],
  wifi: ["Wi-Fi", "Wi-Fi on", "Wi-Fi off"],
  bt: ["Bluetooth", "Bluetooth on", "Bluetooth off"],
  awake: ["Keep awake", "Awake: ON", "Awake: OFF"],
  dark: ["Tema", "Gelap", "Terang"],
};

function paintQuick(q: Quick) {
  (Object.keys(qIds) as QKey[]).forEach((k) => {
    const el = document.getElementById(qIds[k]);
    if (!el) return;
    const v = q[k];
    el.classList.toggle("na", v === null);
    el.classList.toggle("on", v === true);
    const [na, on, off] = qLabel[k];
    el.querySelector("span")!.textContent = v === null ? na : v ? on : off;
  });
  const wasAwake = keepAwake;
  keepAwake = q.awake === true;
  if (keepAwake !== wasAwake) updateBase();
}
function refreshQuick() {
  invoke<Quick>("quick_state")
    .then((q) => { paintQuick(q); })
    .catch((e) => console.error("quick_state gagal:", e));
}
// klik tombol: Rust mengubah pengaturannya lalu mengembalikan keadaan terbaru
([...Object.keys(qIds), "lock"] as (QKey | "lock")[]).forEach((k) => {
  const id = k === "lock" ? "q-lock" : qIds[k];
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (k === "lock") flash("sleepy", 1500);
    invoke<Quick>("quick_toggle", { kind: k })
      .then(paintQuick)
      .catch((err) => console.error("quick_toggle gagal:", err));
  });
});

// ---------- status sistem (CPU / RAM / jaringan) ----------
type Stats = {
  cpu: number; ram: number; ram_used: number; ram_total: number; down: number; up: number;
};
const fmtSpeed = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`;
const GB = 1024 ** 3;

listen<Stats>("stats", (e) => {
  const s = e.payload;
  const cpu = Math.round(s.cpu), ram = Math.round(s.ram);

  const cpuBar = document.getElementById("st-cpu");
  if (!cpuBar) return; // halaman stats dimatikan di config
  cpuBar.style.width = `${cpu}%`;
  cpuBar.classList.toggle("hot", cpu >= 85);
  $("st-cpu-v").textContent = `${cpu}%`;

  const ramBar = $("st-ram");
  ramBar.style.width = `${ram}%`;
  ramBar.classList.toggle("hot", ram >= 90);
  $("st-ram-v").textContent = `${ram}%`;

  $("st-ram-gb").textContent = `${(s.ram_used / GB).toFixed(1)} / ${(s.ram_total / GB).toFixed(0)} GB`;
  $("st-down").textContent = `↓ ${fmtSpeed(s.down)}`;
  $("st-up").textContent = `↑ ${fmtSpeed(s.up)}`;
});

// ---------- riwayat clipboard ----------
function paintClip(items: string[]) {
  const list = document.getElementById("clip-list");
  if (!list) return; // halaman clipboard dimatikan di config

  $("clip-count").textContent = items.length ? `Clipboard · ${items.length}` : "Clipboard";
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "clip-empty";
    empty.textContent = "Belum ada yang disalin";
    list.appendChild(empty);
    return;
  }

  items.forEach((text) => {
    const row = document.createElement("button"); // button: tidak memicu drag geser halaman
    row.className = "clip-item";
    row.title = text.length > 300 ? text.slice(0, 300) + "…" : text;
    const flat = text.replace(/\s+/g, " ").trim();
    row.textContent = flat.length > 56 ? flat.slice(0, 56) + "…" : flat;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      invoke("clip_copy", { text }); // Rust menyalin ulang dan memindahkannya ke paling atas
      flash("happy", 1000);
    });
    list.appendChild(row);
  });
}

function refreshClip() {
  invoke<string[]>("clip_list").then(paintClip).catch(() => { });
}

listen<string[]>("clipboard", (e) => paintClip(e.payload));

document.getElementById("clip-clear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  invoke<string[]>("clip_clear").then(paintClip).catch(() => { });
  flash("surprised", 900);
});

refreshClip();

// ---------- indikator mic / kamera ----------
type Privacy = { mic: boolean; cam: boolean; mic_app: string; cam_app: string };
let priv: Privacy | null = null;

// titik di notch mengikuti status terakhir dari Rust, selama fitur dinyalakan
function paintPrivacy() {
  const on =
    privacyOn && priv
      ? [priv.cam ? "cam" : "", priv.mic ? "mic" : ""].filter(Boolean).join(" ")
      : "";
  if (on) notch.dataset.priv = on;
  else notch.removeAttribute("data-priv");
}

listen<Privacy>("privacy", (e) => {
  const p = e.payload;
  const prev = priv;
  priv = p; // selalu disimpan, supaya langsung tampil saat fitur dinyalakan dari pengaturan
  paintPrivacy();

  if (!privacyOn || !prev) return; // event pertama hanya menandai keadaan awal, tanpa kartu
  if (p.cam && !prev.cam) {
    showDevice("camera", "Kamera aktif", true, p.cam_app ? `Dipakai ${p.cam_app}` : "Sedang digunakan");
    flash("suspicious", 2500);
  } else if (p.mic && !prev.mic) {
    showDevice("mic", "Mikrofon aktif", true, p.mic_app ? `Dipakai ${p.mic_app}` : "Sedang digunakan");
    flash("suspicious", 2500);
  }
});

// ---------- lirik lagu (diperluas dari halaman media) ----------
type LyLine = { t: number; text: string };
type Lyrics = { synced: boolean; lines: LyLine[] };

let ly: Lyrics | null = null;
let lyKey = "";
let lyState: "idle" | "loading" | "none" | "ok" = "idle";
let lyToken = 0;
let lyIdx = -2;
const LY_LEAD = 0.3; // detik: tampilkan baris sedikit lebih awal supaya terasa sinkron
const lyLines = $("ly-lines");
const lyScroll = $("ly-scroll");
const markManual = () => { lyManualAt = Date.now(); };
lyScroll.addEventListener("wheel", markManual, { passive: true });
lyScroll.addEventListener("pointerdown", markManual);

// jam media: posisi dari Rust datang tiap detik, di sini diinterpolasi supaya mulus
let clockPos = 0, clockLen = 0, clockAt = 0, clockPlaying = false;
let lyManualAt = 0; // waktu terakhir pengguna menggulir sendiri (auto-scroll berhenti sebentar)
const nowPos = () => clockPos + (clockPlaying ? (performance.now() - clockAt) / 1000 : 0);

function onMediaForLyrics(m: Media) {
  clockPos = m.position;
  clockLen = m.length;
  clockAt = performance.now();
  clockPlaying = m.active && m.playing;
  // Pencarian lirik untuk compact view tetap aktif meskipun halaman Lyrics
  // tidak dimasukkan ke daftar halaman konfigurasi.
  const key = m.active && m.title ? `${m.artist}|${m.title}` : "";
  if (key === lyKey) return;

  lyKey = key;
  ly = null;
  const token = ++lyToken;
  if (!key) {
    lyState = "idle";
    updateCompactLyric();
    renderLyrics();
    return;
  }

  lyState = "loading";
  renderLyrics();
  invoke<Lyrics | null>("lyrics_fetch", { title: m.title, artist: m.artist, length: m.length })
    .then((r) => {
      if (token !== lyToken) return; // lagu sudah ganti
      ly = r && r.lines.length ? r : null;
      lyState = ly ? "ok" : "none";
      renderLyrics();
    })
    .catch(() => {
      if (token !== lyToken) return;
      lyState = "none";
      renderLyrics();
    });
}

// bangun daftar baris (dipanggil saat status lirik berubah, bukan tiap detik)
function renderLyrics() {
  document.getElementById("m-lyrics")?.classList.toggle("off", lyState === "idle" || lyState === "none");
  lyLines.classList.toggle("plain", !!ly && !ly.synced);
  lyLines.replaceChildren();
  lyIdx = -2;

  updateCompactLyric();

  if (lyState !== "ok" || !ly) {
    const d = document.createElement("div");
    d.className = "ly-msg";
    d.textContent =
      lyState === "loading" ? "Mencari lirik…"
        : lyState === "none" ? "Lirik tidak ditemukan"
          : "Putar musik untuk melihat lirik";
    lyLines.appendChild(d);
    return;
  }
  if (!ly.synced) {
    const note = document.createElement("div");
    note.className = "ly-note";
    note.textContent = "Lirik tanpa waktu — gulir otomatis hanya perkiraan";
    lyLines.appendChild(note);
  }
  ly.lines.forEach((l) => {
    const d = document.createElement("div");
    d.className = "ly-l";
    d.textContent = l.text || "♪";
    lyLines.appendChild(d);
  });
  if (notch.dataset.view === "lyr") tickLyrics(true);
}

function lyIndex(): number {
  if (!ly) return -1;
  const p = nowPos() + LY_LEAD;

  // Lirik tersinkronisasi menggunakan timestamp LRC.
  if (ly.synced) {
    let lo = 0, hi = ly.lines.length - 1, r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ly.lines[mid].t <= p) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }

  // Lirik tanpa timestamp tidak bisa benar-benar sinkron; estimasikan dari progres lagu.
  if (clockLen <= 0 || !ly.lines.length) return 0;
  return Math.min(ly.lines.length - 1, Math.floor(Math.max(0, Math.min(0.999, p / clockLen)) * ly.lines.length));
}

function updateCompactLyric() {
  const visible = playing && lyState === "ok" && !!ly?.lines.length;
  compactLyrics.classList.toggle("visible", visible);
  if (!visible || !ly) {
    compactLyrics.textContent = "";
    compactLyrics.removeAttribute("title");
    return;
  }

  const i = lyIndex();
  const line = i >= 0 ? (ly.lines[i]?.text || "♪") : "♪";
  if (compactLyrics.textContent !== line) {
    compactLyrics.textContent = line;
    compactLyrics.title = line;
    compactLyrics.classList.remove("lyric-change");
    // Paksa animasi transisi berjalan kembali setiap pergantian baris.
    void compactLyrics.offsetWidth;
    compactLyrics.classList.add("lyric-change");
  }
}

function centerLyric(instant: boolean) {
  const el = lyLines.querySelector<HTMLElement>(".ly-l.cur");
  if (!el) return;
  lyScroll.scrollTo({
    top: el.offsetTop - lyScroll.clientHeight / 2 + el.offsetHeight / 2,
    behavior: instant ? "auto" : "smooth",
  });
}

// sorot baris yang sedang dinyanyikan. Lirik tanpa waktu: gulir kira-kira sesuai persentase lagu.
function tickLyrics(force = false) {
  updateCompactLyric();
  if (lyState !== "ok" || !ly) return;
  const manual = Date.now() - lyManualAt < 4000; // pengguna baru menggulir: jangan ditarik balik

  if (!ly.synced) {
    if (clockLen <= 0 || (manual && !force)) return;
    const max = lyScroll.scrollHeight - lyScroll.clientHeight;
    lyScroll.scrollTop = Math.max(0, Math.min(1, nowPos() / clockLen)) * max;
    return;
  }

  const i = lyIndex();
  if (i === lyIdx && !force) return;
  lyIdx = i;
  lyLines.querySelector(".cur")?.classList.remove("cur");
  const el = i >= 0 ? lyLines.querySelectorAll(".ly-l")[i] : undefined;
  el?.classList.add("cur");
  if (!manual || force) centerLyric(force);
}
// Perbarui lirik ringkas juga ketika notch berada di compact view.
setInterval(() => {
  if (notch.dataset.view === "lyr") tickLyrics();
  else updateCompactLyric();
}, 200);

function openLyrics() {
  hubByHover = true; // menutup otomatis saat kursor keluar, seperti hub
  closeAt = 0;
  expand("lyr", 0);
  tickLyrics(true);
}
if (!featureOn("lyrics")) document.getElementById("m-lyrics")?.remove();
document.getElementById("m-lyrics")?.addEventListener("click", (e) => { e.stopPropagation(); openLyrics(); });
$("ly-back").addEventListener("click", (e) => { e.stopPropagation(); openHub(pageOf("media")); });
renderLyrics(); // pesan awal "Putar musik..."

// ---------- kalender (diperluas dari halaman jam) ----------
// Klik tanggal di halaman jam -> kalender bulanan penuh dengan hari libur & peringatan Indonesia.
// Menutup: tombol panah atas (kembali ke halaman jam) atau lepas hover, seperti hub.
function openCalendar() {
  goToday(); // selalu mulai dari bulan ini
  hubByHover = true;
  closeAt = 0;
  expand("cal", 0);
}
if (clockOn) {
  initCalendar();
  document
    .querySelector<HTMLElement>(".p-clock .ck-date")
    ?.addEventListener("click", (e) => { e.stopPropagation(); openCalendar(); });
  $("cal-back").addEventListener("click", (e) => { e.stopPropagation(); openHub(pageOf("clock")); });
} else {
  document.querySelector(".l-cal")?.remove(); // tanpa halaman jam tidak ada jalan masuk ke kalender
}

// ---------- shelf file ----------
type ShelfItem = { path: string; name: string; dir: boolean };
const EXT_ICON: Record<string, string> = {
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️", bmp: "🖼️",
  mp3: "🎵", flac: "🎵", wav: "🎵", ogg: "🎵", m4a: "🎵",
  mp4: "🎬", mkv: "🎬", mov: "🎬", avi: "🎬", webm: "🎬",
  pdf: "📕", doc: "📝", docx: "📝", txt: "📝", md: "📝", odt: "📝",
  xls: "📊", xlsx: "📊", csv: "📊", ppt: "📽️", pptx: "📽️",
  zip: "🗜️", rar: "🗜️", "7z": "🗜️", gz: "🗜️", tar: "🗜️",
  js: "📜", ts: "📜", py: "📜", rs: "📜", json: "📜", html: "📜", css: "📜",
  exe: "⚙️", msi: "⚙️", deb: "⚙️", appimage: "⚙️",
};
const iconFor = (it: ShelfItem) =>
  it.dir ? "📁" : EXT_ICON[(it.name.split(".").pop() ?? "").toLowerCase()] ?? "📄";

function paintShelf(items: ShelfItem[]) {
  const list = document.getElementById("sh-list");
  if (!list) return; // halaman shelf dimatikan di config
  $("sh-count").textContent = items.length ? `Shelf · ${items.length}` : "Shelf";
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sh-empty";
    empty.textContent = "Seret file ke notch";
    list.appendChild(empty);
    return;
  }

  items.forEach((it) => {
    const b = document.createElement("button"); // button: tidak memicu geser halaman
    b.className = "sh-item";
    b.title = `${it.path}\nKlik: buka · Klik kanan: tampilkan di folder`;

    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = iconFor(it);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = it.name;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    b.append(ic, nm, x);

    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest(".x")) {
        invoke<ShelfItem[]>("shelf_remove", { path: it.path }).then(paintShelf).catch(() => { });
      } else {
        invoke("shelf_open", { path: it.path });
        flash("happy", 1000);
      }
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      invoke("shelf_reveal", { path: it.path });
    });
    list.appendChild(b);
  });
}

function refreshShelf() {
  invoke<ShelfItem[]>("shelf_list").then(paintShelf).catch(() => { });
}

document.getElementById("sh-clear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  invoke<ShelfItem[]>("shelf_clear").then(paintShelf).catch(() => { });
  flash("surprised", 900);
});

// file diseret dari aplikasi lain ke notch: buka halaman shelf saat masuk, simpan saat dilepas
if (names.includes("shelf")) {
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "enter") {
        notch.classList.add("dropping");
        hubByHover = false;
        openHub(pageOf("shelf"), 8000);
        flash("surprised", 1200);
      } else if (p.type === "leave") {
        notch.classList.remove("dropping");
        expand("hub", 1200);
      } else if (p.type === "drop") {
        notch.classList.remove("dropping");
        if (p.paths.length === 0) return;
        invoke<ShelfItem[]>("shelf_add", { paths: p.paths })
          .then((items) => {
            paintShelf(items);
            openHub(pageOf("shelf"), 3500);
            flash("love", 1500);
          })
          .catch(() => { });
      }
    })
    .catch(() => { });
}
refreshShelf();

// ---------- pengingat (reminder) ----------
type RepeatMode = "none" | "daily" | "monthly";
type Reminder = {
  id: string;
  text: string;
  due_at: number;
  done: boolean;
  notified: boolean;
  repeat_mode?: RepeatMode | string;
  repeat_daily?: boolean; // kompatibilitas dengan data lama
  repeat_anchor_at: number;
  repeat_day_of_month?: number;
  repeat_timezone_offset_minutes?: number;
};

const fmtDue = (ms: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("id-ID", {
    day: "numeric", month: "short",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

// pengingat yang sedang berbunyi; kartu tetap tampil sampai Selesai / Tunda ditekan
const ringing = new Map<string, Reminder>();
let audioCtx: AudioContext | null = null;

function beep() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    [0, 0.2].forEach((off) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.25, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(t + off);
      o.stop(t + off + 0.16);
    });
  } catch { /* audio tidak tersedia: kartu tetap tampil */ }
}

function showRing() {
  const list = [...ringing.values()];
  if (list.length === 0) {
    if (override === "rem") collapse();
    return;
  }
  const r = list[0];
  $("rem-text").textContent = r.text;
  $("rem-sub").textContent =
    list.length > 1
      ? `Pengingat · +${list.length - 1} lagi`
      : `Pengingat${r.due_at ? " · " + fmtDue(r.due_at) : ""}`;
  hubByHover = false;
  expand("rem", 0); // tanpa timer: tidak hilang sendiri
}

function endRing(action: "stop" | "snooze") {
  const r = [...ringing.values()][0];
  if (!r) return;
  ringing.delete(r.id);
  const call = action === "stop"
    ? invoke<Reminder[]>("reminders_stop", { id: r.id })
    : invoke<Reminder[]>("reminders_snooze", { id: r.id, minutes: 5 });
  call.then(paintReminders).catch(() => { });
  flash(action === "stop" ? "happy" : "sleepy", 1200);
  showRing(); // tampilkan pengingat berikutnya, atau tutup kalau sudah habis
}
document.getElementById("rem-stop")?.addEventListener("click", (e) => { e.stopPropagation(); endRing("stop"); });
document.getElementById("rem-snooze")?.addEventListener("click", (e) => { e.stopPropagation(); endRing("snooze"); });

function paintReminders(items: Reminder[]) {
  // sinkronkan kartu: pengingat yang diselesaikan/dihapus/ditunda dari menu ikut hilang
  let changed = false;
  for (const id of [...ringing.keys()]) {
    const it = items.find((r) => r.id === id);
    if (!it || it.done || it.due_at > Date.now()) { ringing.delete(id); changed = true; }
  }
  if (changed) showRing();

  const list = document.getElementById("rm-list");
  if (!list) return; // halaman reminder dimatikan di config
  const left = items.filter((r) => !r.done).length;
  $("rm-count").textContent = left ? String(left) : "";
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rm-empty";
    empty.textContent = "Belum ada pengingat";
    list.appendChild(empty);
    return;
  }

  const now = Date.now();
  items.forEach((r) => {
    const overdue = !r.done && r.due_at > 0 && r.due_at <= now;
    const row = document.createElement("button"); // button: tidak memicu geser halaman
    row.className = "rm-item" + (r.done ? " done" : "") + (overdue ? " overdue" : "");
    row.title = r.text;

    const dot = document.createElement("span");
    dot.className = "dot";
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = r.text;
    row.append(dot, txt);
    if (r.due_at) {
      const due = document.createElement("span");
      due.className = "due";
      const mode: RepeatMode = r.repeat_mode === "monthly"
        ? "monthly"
        : (r.repeat_mode === "daily" || r.repeat_daily ? "daily" : "none");
      const repeatLabel = mode === "daily"
        ? " · ↻ Harian"
        : mode === "monthly"
          ? ` · ↻ Tanggal ${r.repeat_day_of_month || new Date(r.repeat_anchor_at || r.due_at).getDate()}/bln`
          : "";
      due.textContent = `${fmtDue(r.due_at)}${repeatLabel}`;
      row.appendChild(due);
    }
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    row.appendChild(x);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest(".x")) {
        invoke<Reminder[]>("reminders_remove", { id: r.id }).then(paintReminders).catch(() => { });
      } else {
        invoke<Reminder[]>("reminders_toggle", { id: r.id }).then(paintReminders).catch(() => { });
        if (!r.done) flash("happy", 900);
      }
    });
    list.appendChild(row);
  });
}

function refreshReminders() {
  invoke<Reminder[]>("reminders_list").then(paintReminders).catch(() => { });
}

document.getElementById("rm-clear-done")?.addEventListener("click", (e) => {
  e.stopPropagation();
  invoke<Reminder[]>("reminders_clear_done").then(paintReminders).catch(() => { });
});

// ---- picker tanggal, jam, dan pengulangan ----
const remPage = document.querySelector<HTMLElement>(".p-reminder");
let pickAt = 0;      // waktu terpilih (ms), 0 = tanpa waktu
let pk = new Date(); // nilai yang sedang diatur di picker
let repeatMode: RepeatMode = "none";

function paintWhen() {
  $("rm-when-txt").textContent = pickAt ? fmtDue(pickAt) : "";
  $("rm-when").classList.toggle("set", pickAt !== 0);
}

function paintRepeatMode() {
  const select = document.getElementById("pk-repeat-mode") as HTMLSelectElement | null;
  if (select) select.value = repeatMode;
}

const pkDateInput = document.getElementById("pk-date-input") as HTMLInputElement | null;

function formatDmy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  return `${dd}/${mm}/${yyyy}`;
}

// Format otomatis saat pengguna mengetik: dd/mm/yyyy.
function formatDmyInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length < 2) return digits;
  if (digits.length === 2) return `${digits}/`;
  if (digits.length < 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function parseDmy(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(year, month - 1, day);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null;
  return { year, month, day };
}

function setPkDateFromInput(): boolean {
  if (!pkDateInput) return false;
  const parsed = parseDmy(pkDateInput.value);
  if (!parsed) return false;
  // Konstruksi ulang tanggal agar tanggal 31 tidak overflow saat berpindah bulan.
  pk = new Date(parsed.year, parsed.month - 1, parsed.day, pk.getHours(), pk.getMinutes(), 0, 0);
  return true;
}

function paintPick() {
  $("pk-h").textContent = String(pk.getHours()).padStart(2, "0");
  $("pk-m").textContent = String(pk.getMinutes()).padStart(2, "0");
}

// Jaga ukuran panel hub ketika picker pengingat atau daftar catatan diperluas.
// Window native tetap berukuran tetap; ukuran view dan hitbox disesuaikan di dalamnya.
function syncHubDynamicHeight() {
  const reminderExpanded = notch.classList.contains("reminder-picking");
  const notesExpanded = notch.classList.contains("notes-expanded");
  const height = reminderExpanded ? 230 : notesExpanded ? 300 : BASE_SIZES.hub[1];
  const hitHeight = reminderExpanded ? 242 : notesExpanded ? 330 : BASE_HIT.hub[1];
  SIZES.hub[1] = Math.round(height * CFG.scale);
  HIT.hub[1] = Math.round(hitHeight * CFG.scale);
  if (notch.dataset.view === "hub") {
    placeShell("hub");
    setHit("hub");
  }
}

// Saat picker terbuka, beri ruang vertikal tambahan agar baris pengulangan tidak terpotong.
function setReminderPickerExpanded(expanded: boolean) {
  notch.classList.toggle("reminder-picking", expanded);
  syncHubDynamicHeight();
}

function openPick() {
  if (pickAt) {
    pk = new Date(pickAt);
    if (pkDateInput) pkDateInput.value = formatDmy(pk);
  } else {
    // Tanggal default selalu hari ini; waktu awal dibulatkan ke kelipatan 5 menit berikutnya.
    const today = new Date();
    if (pkDateInput) pkDateInput.value = formatDmy(today);
    pk = new Date(today);
    pk.setMinutes(Math.ceil(pk.getMinutes() / 5) * 5, 0, 0);
  }
  pkDateInput?.classList.remove("invalid");
  pkDateInput?.removeAttribute("aria-invalid");
  paintPick();
  paintRepeatMode();
  remPage?.classList.add("picking");
  setReminderPickerExpanded(true);
}
const closePick = () => {
  remPage?.classList.remove("picking");
  setReminderPickerExpanded(false);
};

document.getElementById("rm-when")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (remPage?.classList.contains("picking")) closePick(); else openPick();
});
document.querySelectorAll<HTMLElement>("[data-pk]").forEach((b) =>
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const [unit, sign] = [b.dataset.pk![0], b.dataset.pk![1] === "+" ? 1 : -1];
    if (unit === "h") pk.setHours(pk.getHours() + sign);
    else if (unit === "m") pk.setMinutes(pk.getMinutes() + sign * 5);
    paintPick();
  })
);

// Sisipkan garis miring otomatis setelah DD dan MM, sambil menjaga posisi caret.
pkDateInput?.addEventListener("input", () => {
  const oldValue = pkDateInput.value;
  const oldCaret = pkDateInput.selectionStart ?? oldValue.length;
  const digitsBeforeCaret = oldValue.slice(0, oldCaret).replace(/\D/g, "").length;
  const formatted = formatDmyInput(oldValue);
  pkDateInput.value = formatted;

  let nextCaret = digitsBeforeCaret;
  if (digitsBeforeCaret === 2 && formatted.length >= 3) nextCaret = 3;
  else if (digitsBeforeCaret === 4 && formatted.length >= 6) nextCaret = 6;
  else if (digitsBeforeCaret > 2 && digitsBeforeCaret < 4) nextCaret = digitsBeforeCaret + 1;
  else if (digitsBeforeCaret > 4) nextCaret = digitsBeforeCaret + 2;
  nextCaret = Math.min(nextCaret, formatted.length);
  pkDateInput.setSelectionRange(nextCaret, nextCaret);
  pkDateInput.classList.remove("invalid");
  pkDateInput.removeAttribute("aria-invalid");

  const parsed = parseDmy(formatted);
  if (parsed) {
    pk = new Date(parsed.year, parsed.month - 1, parsed.day, pk.getHours(), pk.getMinutes(), 0, 0);
  }
});

pkDateInput?.addEventListener("keydown", (e) => {
  e.stopPropagation();
  // Backspace tepat setelah slash menghapus digit di depannya, bukan slash otomatis.
  if (e.key === "Backspace" && pkDateInput.selectionStart === pkDateInput.selectionEnd) {
    const caret = pkDateInput.selectionStart ?? 0;
    if (caret > 0 && pkDateInput.value[caret - 1] === "/") {
      e.preventDefault();
      const digits = pkDateInput.value.replace(/\D/g, "");
      const digitsBefore = pkDateInput.value.slice(0, caret - 1).replace(/\D/g, "").length;
      const removeAt = Math.max(0, digitsBefore - 1);
      const nextDigits = digits.slice(0, removeAt) + digits.slice(removeAt + 1);
      pkDateInput.value = formatDmyInput(nextDigits);
      const nextCaret = Math.min(removeAt, pkDateInput.value.length);
      pkDateInput.setSelectionRange(nextCaret, nextCaret);
      pkDateInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
});
document.getElementById("pk-repeat-mode")?.addEventListener("change", (e) => {
  e.stopPropagation();
  const value = (e.currentTarget as HTMLSelectElement).value;
  repeatMode = value === "daily" || value === "monthly" ? value : "none";
});
document.getElementById("pk-ok")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!setPkDateFromInput()) {
    pkDateInput?.classList.add("invalid");
    pkDateInput?.setAttribute("aria-invalid", "true");
    pkDateInput?.focus();
    return;
  }
  pk.setSeconds(0, 0);
  pickAt = pk.getTime();
  pkDateInput?.classList.remove("invalid");
  pkDateInput?.removeAttribute("aria-invalid");
  paintWhen();

  // Jika teks pengingat sudah diisi, tombol Atur sekaligus menyimpan item ke daftar.
  // Jika input masih kosong, simpan pilihan tanggal/jam sementara dan tutup picker;
  // item bisa dibuat setelah teks diisi dengan tombol tambah.
  const reminderText = (document.getElementById("rm-input") as HTMLInputElement | null)?.value.trim();
  if (reminderText) {
    addReminder();
    return;
  }
  closePick();
});
document.getElementById("pk-clear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  pickAt = 0;
  pkDateInput?.classList.remove("invalid");
  pkDateInput?.removeAttribute("aria-invalid");
  repeatMode = "none";
  paintWhen();
  paintRepeatMode();
  closePick();
});

function addReminder() {
  const input = $("rm-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  const mode: RepeatMode = pickAt > 0 ? repeatMode : "none";
  const timezoneOffsetMinutes = pickAt > 0 ? new Date(pickAt).getTimezoneOffset() : new Date().getTimezoneOffset();
  invoke<Reminder[]>("reminders_add", {
    text,
    dueAt: pickAt,
    repeatMode: mode,
    timezoneOffsetMinutes,
  })
    .then((items) => {
      paintReminders(items);
      input.value = "";
      pickAt = 0;
      repeatMode = "none";
      paintWhen();
      paintRepeatMode();
      closePick();
      flash("happy", 900);
    })
    .catch(() => { });
}
document.getElementById("rm-add-btn")?.addEventListener("click", (e) => { e.stopPropagation(); addReminder(); });
document.getElementById("rm-input")?.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e as KeyboardEvent).key === "Enter") addReminder();
});
paintWhen();
paintRepeatMode();

// dikirim Rust saat jatuh tempo, lalu diulang tiap 20 detik sampai dihentikan
listen<Reminder>("reminder-due", (e) => {
  const r = e.payload;
  const first = !ringing.has(r.id);
  ringing.set(r.id, r);
  beep();
  if (first || override === null) {
    flash("surprised", 2500);
    showRing();
  } else {
    flash("surprised", 1200);
  }
  refreshReminders();
});

refreshReminders();

// ---------- catatan (notes) — tersimpan permanen, terpisah dari config ----------
type Note = { id: string; text: string; updated_at: number };

function fmtNoteDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Baru saja";
  if (diffMin < 60) return `${diffMin} mnt lalu`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} jam lalu`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD} hari lalu`;
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function openNoteDetail(n: Note) {
  invoke("open_note_detail", { id: n.id }).catch(console.error);
}
function paintNotes(items: Note[]) {
  const list = document.getElementById("nt-list");
  if (!list) return;
  $("nt-count").textContent = items.length ? String(items.length) : "";
  list.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "nt-empty";
    empty.textContent = "Belum ada catatan";
    list.appendChild(empty);
    return;
  }

  items.forEach((n) => {
    const card = document.createElement("button");
    card.className = "nt-item";
    card.title = "Klik untuk buka detail";

    // Preview teks (2 baris pertama)
    const preview = document.createElement("span");
    preview.className = "nt-item-preview";
    const lines = n.text.split("\n");
    preview.textContent = lines.slice(0, 2).join(" ").slice(0, 120) + (n.text.length > 120 ? "…" : "");

    // Meta baris bawah
    const meta = document.createElement("span");
    meta.className = "nt-item-meta";

    const dateSpan = document.createElement("span");
    dateSpan.className = "nt-item-date";
    dateSpan.textContent = fmtNoteDate(n.updated_at);

    const lenSpan = document.createElement("span");
    lenSpan.className = "nt-item-len";
    lenSpan.textContent = `${n.text.length} kar`;

    meta.appendChild(dateSpan);
    meta.appendChild(lenSpan);

    // Tombol hapus
    const delBtn = document.createElement("span");
    delBtn.className = "nt-item-del";
    delBtn.textContent = "×";
    delBtn.title = "Hapus";

    card.appendChild(preview);
    card.appendChild(meta);
    card.appendChild(delBtn);

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest(".nt-item-del")) {
        invoke<Note[]>("notes_remove", { id: n.id }).then(paintNotes).catch(() => { });
      } else {
        openNoteDetail(n);
      }
    });

    list.appendChild(card);
  });
}

function setNotesExpanded(expanded: boolean) {
  notch.classList.toggle("notes-expanded", expanded);
  const button = document.getElementById("nt-expand");
  if (button) {
    const label = expanded ? "Sembunyikan daftar catatan" : "Tampilkan daftar catatan";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  syncHubDynamicHeight();
}

document.getElementById("nt-expand")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setNotesExpanded(!notch.classList.contains("notes-expanded"));
});

function refreshNotes() {
  invoke<Note[]>("notes_list").then(paintNotes).catch(() => { });
}

// Dengarkan perubahan dari jendela detail
listen("notes-changed", () => refreshNotes()).catch(() => { });

document.getElementById("nt-clear")?.addEventListener("click", (e) => {
  e.stopPropagation();
  invoke<Note[]>("notes_clear").then(paintNotes).catch(() => { });
  flash("surprised", 900);
});

function addNote() {
  const input = $("nt-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  invoke<Note[]>("notes_add", { text })
    .then((items) => {
      paintNotes(items);
      input.value = "";
      flash("love", 900);
    })
    .catch(() => { });
}
document.getElementById("nt-add-btn")?.addEventListener("click", (e) => { e.stopPropagation(); addNote(); });
document.getElementById("nt-input")?.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
    e.preventDefault();
    addNote();
  }
});

refreshNotes();

// ---------- tes manual lewat keyboard ----------
// T ganti mata <-> jam | M indikator mic/kamera (demo) | 1-7 mood | B bluetooth | C/V/L baterai | D perangkat | W cuaca | H hub | U/I HUD | P timer | ← → halaman
const keyMoods: Mood[] = ["normal", "happy", "sleepy", "surprised", "angry", "love", "suspicious"];
const demo = Object.keys(ICONS);
let demoI = 0;

document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  const i = Number(e.key) - 1;
  if (i >= 0 && i < keyMoods.length) flash(keyMoods[i], 3000);
  if (k === "b") { void openBtManual(); }
  if (k === "c") handleBattery(80, false);
  if (k === "v") handleBattery(80, true);
  if (k === "l") handleBattery(10, false);
  if (k === "d") {
    const kind = demo[demoI++ % demo.length];
    showDevice(kind, `Contoh ${LABELS[kind]}`, demoI % 4 !== 0);
  }
  if (k === "w") {
    showWeather({ temp: 27, feels: 30, humidity: 82, code: 63, is_day: true, rain_in: 30 }, true);
    openHub(pageOf("weather"), 5000);
  }
  if (k === "h") openHub(page, 5000);
  if (k === "t" && clockOn) { idleFace = idleFace === "clock" ? "eyes" : "clock"; saveFace(idleFace); render(); }
  if (k === "m") {
    if (notch.hasAttribute("data-priv")) notch.removeAttribute("data-priv");
    else { notch.dataset.priv = "cam mic"; showDevice("camera", "Kamera aktif", true, "Dipakai demo"); }
  }
  if (k === "u") showHud("volume", 20 + Math.random() * 80, false);
  if (k === "i") showHud("brightness", 10 + Math.random() * 90, false);
  if (k === "p") { remaining = 3; running = true; endAt = Date.now() + 3000; openHub(pageOf("timer"), 6000); }
  if (e.key === "ArrowRight" && override === "hub") setPage(page + 1);
  if (e.key === "ArrowLeft" && override === "hub") setPage(page - 1);
  if (k === "k" && clockOn) openCalendar();
  if (override === "cal") {
    if (e.key === "ArrowRight") shiftMonth(1);
    if (e.key === "ArrowLeft") shiftMonth(-1);
    if (e.key === "Escape") openHub(pageOf("clock"));
  }
});
initNudge({
  lastMove: () => lastCursorMove,   // gerakan pointer terakhir, dari event "cursor" Rust
  playing: () => playing,
  canShow: () => override === null, // jangan menimpa kartu/hub yang sedang tampil
  card: (title, sub, ms) => {
    $("dev-icon").classList.remove("off", "play");
    $("dev-chip").classList.remove("off");
    $("dev-name").textContent = title;
    $("dev-sub").textContent = sub;
    hubByHover = false;
    expand("dev", ms);
  },
  mood: (m, ms) => flash(m as Mood, ms),
});

// Pengingat jadwal shalat memakai kartu kecil tersendiri, tidak menimpa kartu perangkat.
initPrayer({
  card: (title, sub, ms) => {
    $("pr-alert-title").textContent = title;
    $("pr-alert-sub").textContent = sub;
    hubByHover = false;
    expand("prayerAlert", ms);
  },
  mood: (m, ms) => flash(m as Mood, ms),
});
function safeUpdateUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function showUpdateBanner(currentVersion: string, remote: RemoteUpdateConfig) {
  updateTargetUrl = safeUpdateUrl(remote.link_update) ?? "";
  $("update-current-version").textContent = `Versi saat ini ${currentVersion}`;
  $("update-new-version").textContent = `Versi ${remote.new_version} tersedia untuk diunduh.`;

  const openButton = $("update-open") as HTMLButtonElement;
  openButton.disabled = !updateTargetUrl;
  openButton.title = updateTargetUrl ? `Buka ${updateTargetUrl}` : "Tautan update belum valid";

  // Jangan memotong kartu pengingat/perangkat yang sedang tampil.
  if (override === null || override === "hub" || override === "update") {
    hubByHover = false;
    expand("update", 0); // banner tetap tampil sampai pengguna memilih Nanti atau membuka rilis
  }
}

$("update-later").addEventListener("click", (event) => {
  event.stopPropagation();
  collapse();
});

$("update-open").addEventListener("click", (event) => {
  event.stopPropagation();
  if (!updateTargetUrl) return;
  // link_update sebaiknya URL halaman rilis GitHub yang lengkap.
  window.open(updateTargetUrl, "_blank", "noopener,noreferrer");
  collapse();
});
let updateTargetUrl = "";

function compareVersionStrings(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const clean = value.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
    if (!clean || !/^\d+(?:\.\d+)*$/.test(clean)) return null;
    return clean.split(".").map((part) => Number(part));
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}
void loadRemoteUpdateConfig()
  .then(async (config) => {
    window.__NOTCH_UPDATE_CONFIG__ = config;
    window.dispatchEvent(
      new CustomEvent<RemoteUpdateConfig>("notch:firebase-update-config", { detail: config })
    );
    console.info("[Firebase] Konfigurasi update berhasil dimuat:", config);

    try {
      const currentVersion = await getVersion();
      const comparison = compareVersionStrings(config.new_version, currentVersion);
      if (comparison === null) {
        console.warn("[Firebase] Format versi tidak valid; banner update dilewati.", {
          installed: currentVersion,
          offered: config.new_version,
        });
        return;
      }
      if (comparison > 0) {
        console.info(`[Firebase] Update tersedia: ${currentVersion} -> ${config.new_version}`);
        showUpdateBanner(currentVersion, config);
      } else {
        console.info(`[Firebase] Aplikasi sudah terbaru (terpasang ${currentVersion}).`);
      }
    } catch (error) {
      console.warn("[Firebase] Tidak bisa membaca versi aplikasi Tauri:", error);
    }
  })
  .catch((error: unknown) => {
    console.warn("[Firebase] Gagal memuat notch_config/update_config:", error);
  });
if (clockOn) startClock();
void syncWindow(); // jendela native diset sekali ke ukuran tetap
render();
updateBase();