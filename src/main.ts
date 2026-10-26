import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initNudge } from "./nudge";
import { loadFace, saveFace, startClock, type Face } from "./clock";
import { initCalendar, goToday, shiftMonth } from "./calendar";
// ---------- konfigurasi (dari config.toml lewat Rust) ----------
type Appearance = {
  theme: string;      // "auto" | "dark" | "light" | "custom"
  background: string; // dipakai saat theme = "custom"
  text: string;       // kosong = otomatis kontras
  dark_bg: string;
  light_bg: string;
  accent: string;     // kosong = otomatis dari cover album
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
  pages: ["media", "clock", "weather", "battery", "timer", "quick", "tools", "stats", "clipboard", "shelf", "lyrics", "privacy"],
  timing: { hub_auto_ms: 4000, card_ms: 3500, hud_ms: 1500, hover_open_ms: 150, hover_close_ms: 450, sleep_after_s: 60 },
  pomodoro: { focus_min: 25, break_min: 5, long_break_min: 15, rounds: 4 },
  appearance: { theme: "auto", background: "#000000", text: "", dark_bg: "#000000", light_bg: "#f5f5f7", accent: "" },
};
const CFG: Cfg = { ...FALLBACK, ...((window as any).__CFG__ ?? {}) };
const T = CFG.timing;
// fitur tambahan (bukan halaman) juga diatur lewat daftar pages di config
const featureOn = (name: string) => CFG.pages.includes(name);
// indikator mic/kamera bisa dinyalakan/dimatikan langsung dari jendela pengaturan (tanpa restart)
let privacyOn = featureOn("privacy");

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
const eyes = document.querySelector<HTMLElement>(".eyes")!;
const eyeEls = document.querySelectorAll<HTMLElement>(".eye");
const isWin = navigator.userAgent.includes("Windows");

// ---------- state bersama ----------
type View = "bt" | "dev" | "hub" | "hud" | "lyr" | "cal";
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

// Wajah notch saat tidak ada kartu/musik: mata ("eyes") atau jam + tanggal ("clock").
// Berganti ketika hover dilepas (hub menutup) dan halaman yang terakhir dilihat adalah halaman jam.
const clockOn = featureOn("clock");
let idleFace: Face = clockOn ? loadFace() : "eyes";

// ---------- ukuran (dikalikan skala dari config) ----------
// lebar jendela = lebar pil + 20 (10 di tiap sisi untuk lengkung "telinga" notch)
const BASE_SIZES: Record<string, [number, number]> = {
  idle: [150, 28],
  compact: [250, 40],
  compactLyrics: [360, 40],
  edgeIdle: [80, 80],
  edgeMedia: [80, 120],
  hub: [420, 148],
  bt: [360, 80],
  dev: [360, 80],
  hud: [320, 60],
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
  hub: [400, 140],
  bt: [340, 74],
  dev: [340, 74],
  hud: [300, 52],
  lyr: [400, 222],
  clock: [220, 24],
  cal: [400, 328],
};
const scaleMap = (m: Record<string, [number, number]>) =>
  Object.fromEntries(
    Object.entries(m).map(([k, [w, h]]) => [k, [Math.round(w * CFG.scale), Math.round(h * CFG.scale)]])
  ) as Record<string, [number, number]>;

const SIZES = scaleMap(BASE_SIZES); // ukuran JENDELA
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
osLight.addEventListener("change", applyTheme); // ikut berubah saat tema OS diganti

// ukuran langsung berubah tanpa restart
function applyScale(v: number) {
  CFG.scale = Math.min(1.5, Math.max(0.5, v));
  Object.assign(SIZES, scaleMap(BASE_SIZES));
  Object.assign(HIT, scaleMap(BASE_HIT));
  document.documentElement.style.setProperty("--s", String(CFG.scale));
  lastView = ""; // paksa ukuran jendela & area klik dihitung ulang
  render();
}

// dari jendela pengaturan: pratinjau langsung / hasil simpan
listen<{ appearance?: Appearance; scale?: number; pages?: string[] }>("config-changed", (e) => {
  const p = e.payload;
  if (!p) return;
  if (p.appearance) {
    CFG.appearance = p.appearance;
    applyTheme();
  }
  if (typeof p.scale === "number" && p.scale !== CFG.scale) applyScale(p.scale);
  // indikator mic/kamera langsung menyala/mati sesuai centang di pengaturan
  if (Array.isArray(p.pages)) {
    const on = p.pages.includes("privacy");
    if (on !== privacyOn) {
      privacyOn = on;
      paintPrivacy();
    }
  }
});

function setHit(view: string, winW: number) {
  const [hw, hh] = HIT[view];
  // Ketika menempel di tepi, konten bergeser 10px ke arah tepi.
  // Area interaksi harus ikut rata kiri/kanan, bukan selalu di tengah jendela.
  const x = notch.classList.contains("is-edge-left")
    ? 0
    : notch.classList.contains("is-edge-right")
      ? Math.max(0, Math.round(winW - hw))
      : Math.max(0, Math.round((winW - hw) / 2));
  invoke("set_hit_area", { x, w: hw, h: hh });
}

// ---------- view: idle / compact / hub / bt / dev / hud ----------
let lastView = "";
let appliedView = ""; // view yang ukuran native-nya sudah selesai diterapkan
let sizeRequestId = 0;
let lastSizeRequestAt = 0;

function applySize(view: string, previousView = appliedView || view) {
  const requestId = ++sizeRequestId;
  lastSizeRequestAt = Date.now();
  const [w, h] = SIZES[view];
  const [oldW, oldH] = SIZES[previousView] ?? [w, h];
  const isExpanding = w >= oldW && h >= oldH;

  // Ketika membuka, pasang hitbox besar lebih awal agar hover tetap stabil.
  // Ketika menutup, pertahankan hitbox lama sampai native resize selesai agar
  // click-through tidak berubah di tengah animasi.
  if (isExpanding) setHit(view, w);

  const stillCurrent = () => requestId === sizeRequestId && lastView === view;
  const doResize = () => {
    if (!stillCurrent()) return;
    invoke("set_size", { w, h })
      .then(() => {
        if (!stillCurrent()) return;
        if (!isExpanding) setHit(view, w);
        appliedView = view;
        updatePositionUI(notch.classList.contains("is-custom-pos"), currentTy, currentCx);
      })
      .catch((e) => console.error("Gagal mengubah ukuran notch:", e));
  };

  // Membuka: jendela dibesarkan sekarang supaya notch yang melebar tidak terpotong.
  // Menutup: tunggu animasi CSS notch selesai dulu. Kalau jendela mengecil lebih awal, tepi jendela
  // memotong notch yang masih besar, jadi tampak persegi tanpa sudut membulat sampai animasinya selesai.
  const resize = () => {
    if (isExpanding) { doResize(); return; }
    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      notch.removeEventListener("transitionend", onEnd);
      clearTimeout(fallback);
      doResize();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === notch && (e.propertyName === "height" || e.propertyName === "width")) go();
    };
    notch.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(go, 450); // pengaman kalau tidak ada transisi (ukuran CSS sudah sama)
  };

  if (view === "edgeMedia" || view === "edgeIdle") {
    const sw = window.screen.availWidth || window.screen.width;
    const edgeCx = notch.classList.contains("is-edge-left")
      ? 40
      : notch.classList.contains("is-edge-right") ? sw - 40 : currentCx;
    if (edgeCx !== -1) {
      currentCx = edgeCx;
      invoke("notch_move_to", { cx: edgeCx, ty: currentTy })
        .then(() => { if (stillCurrent()) resize(); })
        .catch((e) => console.error("Gagal mengunci posisi notch di tepi:", e));
    } else {
      resize();
    }
  } else {
    resize();
  }
}
function render() {
  const hasCompactLyrics = playing && lyState === "ok" && !!ly?.lines.length;
  const atScreenSide = notch.classList.contains("is-edge-left") || notch.classList.contains("is-edge-right");
  // Saat pointer baru masuk, tahan state mini sampai hover delay terpenuhi.
  // Dengan begitu expand langsung ke hub, bukan lewat tampilan horizontal perantara.
  const hoverPending = inside && Date.now() - insideSince < T.hover_open_ms;
  const edgeCollapsed = atScreenSide && !override && !isDraggingWindow && (!inside || hoverPending);
  const view = override ?? (
    edgeCollapsed ? (playing ? "edgeMedia" : "edgeIdle")
      : playing ? (hasCompactLyrics ? "compactLyrics" : "compact")
      : idleFace === "clock" ? "clock" : "idle"
  );
  notch.dataset.view = view;
  notch.dataset.playing = String(playing);

  if (view !== lastView) {
    // Catat view asal agar saat collapse hitbox lama bisa dipertahankan hingga akhir.
    const previousView = appliedView || lastView || view;
    settleUntil = Date.now() + 80;
    lastView = view;
    appliedView = "";

    // CSS dan native resize berjalan dengan durasi/kurva selaras; request lama dibatalkan.
    applySize(view, previousView);
  }
}

// pengaman: kalau ukuran jendela tidak cocok dengan view saat ini, terapkan ulang
setInterval(() => {
  // Perintah set_size bisa berlangsung selama animasi native. Jangan memulai
  // animasi kedua ketika perintah pertama belum sempat selesai.
  if (lastView && appliedView !== lastView && Date.now() - lastSizeRequestAt > 2500) {
    applySize(lastView);
  }
}, 1500);

function expand(view: View, ms = 3000) {
  override = view;
  render();
  clearTimeout(hideTimer);
  if (ms > 0) {
    hideTimer = window.setTimeout(() => {
      if (view === "hub" && inside) return;
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
let baseMood: Mood = "normal";
let tempTimer: number | undefined;
let sleeping = false;
let lastActivity = Date.now();

const applyMood = (m: Mood) => { eyes.dataset.mood = m; };

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

  setBase(shouldSleep || lowBattery ? "sleepy" : playing ? "happy" : "normal");
}
setInterval(updateBase, 3000);

function markActive() { lastActivity = Date.now(); if (sleeping) updateBase(); }
document.addEventListener("mousemove", markActive);
document.addEventListener("keydown", markActive);

// ---------- hub: halaman yang bisa digeser ----------
const pagesEl = $("pages");
const track = $("track");
const dotsEl = $("dots");

// buang halaman yang tidak aktif di config, lalu urutkan sesuai config
track.querySelectorAll<HTMLElement>(".page").forEach((p) => {
  if (!CFG.pages.includes(p.dataset.page ?? "")) p.remove();
});
CFG.pages.forEach((name) => {
  const el = track.querySelector(`[data-page="${name}"]`);
  if (el) track.appendChild(el);
});
const names = [...track.querySelectorAll<HTMLElement>(".page")].map((p) => p.dataset.page!);
const pageOf = (n: string) => Math.max(0, names.indexOf(n));
// membuka hub dari wajah jam: mulai di halaman jam, supaya melepas hover tanpa menggeser tetap menjaga jam
const homePage = () => (clockOn && idleFace === "clock" ? pageOf("clock") : page);
const pageCount = names.length;
let page = 0;

for (let i = 0; i < pageCount; i++) {
  const d = document.createElement("span");
  d.className = "dot";
  d.addEventListener("click", (e) => { e.stopPropagation(); setPage(i); });
  dotsEl.appendChild(d);
}

function setPage(i: number) {
  page = Math.max(0, Math.min(pageCount - 1, i));
  track.style.setProperty("--page", String(page));
  track.style.setProperty("--drag", "0px");
  dotsEl.querySelectorAll(".dot").forEach((d, n) => d.classList.toggle("active", n === page));
  if (names[page] === "quick" || names[page] === "tools") refreshQuick();
  if (names[page] === "clipboard") refreshClip();
  if (names[page] === "shelf") refreshShelf();
}
setPage(0);

function openHub(p: number, ms = 0) {
  setPage(p);
  hubByHover = ms === 0;
  closeAt = 0;
  expand("hub", ms);
}

// geser dengan drag mouse
let startX = 0, dx = 0, dragging = false, moved = false;

pagesEl.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  dragging = true; moved = false; startX = e.clientX; dx = 0;
  track.classList.add("dragging");
});
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
  if ((e.target as HTMLElement).closest(".clip-list")) return; // biarkan daftar clipboard di-scroll
  const sh = (e.target as HTMLElement).closest<HTMLElement>(".sh-list"); // shelf: scroll mendatar
  if (sh && sh.scrollWidth > sh.clientWidth) { sh.scrollLeft += e.deltaY || e.deltaX; return; }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(d) < 10 || wheelLock) return;
  wheelLock = true;
  setTimeout(() => { wheelLock = false; }, 350);
  setPage(page + (d > 0 ? 1 : -1));
}, { passive: true });

// ---------- hover: dihitung dari posisi kursor ----------
function setInside(v: boolean) {
  if (v === inside) return;
  inside = v;
  insideSince = v ? Date.now() : 0;
  if (v) flash("surprised", 900);
  render();
}

const rectHas = (x: number, y: number) => {
  const r = notch.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};
if (!isWin) {
  window.addEventListener("pointermove", (e) => setInside(rectHas(e.clientX, e.clientY)));
  window.addEventListener("pointerup", (e) => setInside(rectHas(e.clientX, e.clientY)));
  notch.addEventListener("mouseenter", () => setInside(true));
  document.documentElement.addEventListener("mouseleave", () => setInside(false));
  window.addEventListener("blur", () => setInside(false));
}

// watchdog: buka/tutup hub dengan hysteresis
setInterval(() => {
  const now = Date.now();
  if (dragging || isDraggingWindow || now < settleUntil) return;

  if (override === "hub" || override === "lyr" || override === "cal") {
    if (inside) {
      if (!hubByHover) { clearTimeout(hideTimer); hubByHover = true; }
      closeAt = 0;
    } else if (hubByHover) {
      if (!closeAt) closeAt = now + T.hover_close_ms;
      else if (now >= closeAt) { closeAt = 0; collapse(); }
    }
  } else {
    closeAt = 0;
    if (!override && inside && now - insideSince > T.hover_open_ms) openHub(homePage());
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

let currentCx = -1;
let currentTy = 0;

function updatePositionUI(custom: boolean, topY: number, cx?: number) {
  if (cx !== undefined) currentCx = cx;
  currentTy = topY;

  // Floating mengatur bentuk untuk posisi di bawah tepi atas; deteksi sisi layar
  // harus tetap aktif walaupun topY = 0 (mis. notch di pojok kiri/kanan atas).
  const isFloating = custom && topY > 8;
  notch.classList.toggle("is-custom-pos", custom);
  notch.classList.toggle("is-floating", isFloating);
  const shell = $("shell");
  if (shell) shell.classList.toggle("is-floating", isFloating);

  if (custom && currentCx !== -1) {
    const sw = window.screen.availWidth || window.screen.width;
    // currentCx adalah titik tengah jendela yang dipindahkan. Pakai setengah
    // lebar jendela terluas (hub/calendar), bukan compactLyrics, agar deteksi
    // tetap benar ketika posisi disimpan saat hub sedang terbuka.
    const maxWindowWidth = Math.max(...Object.values(SIZES).map(([w]) => w));
    const edgeHalfW = maxWindowWidth / 2;
    const leftDistance = currentCx - edgeHalfW;
    const rightDistance = sw - (currentCx + edgeHalfW);
    const wasLeft = notch.classList.contains("is-edge-left");
    const wasRight = notch.classList.contains("is-edge-right");

    // Hysteresis: masuk sisi pada 10px, tetapi pertahankan status sampai
    // jarak melewati 28px agar ukuran/posisi yang berubah tidak memicu flicker.
    const isLeft = wasLeft ? leftDistance <= 28 : leftDistance <= 10;
    const isRight = wasRight ? rightDistance <= 28 : rightDistance <= 10;
    const wasEdge = wasLeft || wasRight;

    notch.classList.toggle("is-edge-left", isLeft && !isRight);
    notch.classList.toggle("is-edge-right", isRight && !isLeft);
    if (shell) {
      shell.classList.toggle("is-edge-left", isLeft && !isRight);
      shell.classList.toggle("is-edge-right", isRight && !isLeft);
    }
    const isEdge = (isLeft && !isRight) || (isRight && !isLeft);
    if (wasEdge !== isEdge || wasLeft !== notch.classList.contains("is-edge-left") || wasRight !== notch.classList.contains("is-edge-right")) {
      render();
    }
  } else {
    const wasEdge = notch.classList.contains("is-edge-left") || notch.classList.contains("is-edge-right");
    notch.classList.remove("is-edge-left", "is-edge-right");
    if (shell) shell.classList.remove("is-edge-left", "is-edge-right");
    if (wasEdge) render();
  }
}

async function startWindowDrag(e: PointerEvent, targetEl: HTMLElement) {
  if (e.button !== 0) return; // hanya klik kiri
  try {
    const pos = await invoke<[number, number]>("notch_start_move");
    startCx = pos[0];
    startTy = pos[1];
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    isDraggingWindow = true;
    windowDragMoved = false;
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
    const newCx = startCx + dx;
    const newTy = startTy + dy;
    invoke("notch_move_to", { cx: newCx, ty: newTy });
    updatePositionUI(true, newTy, newCx);
  }
}

function onWindowPointerUp(e: PointerEvent, targetEl: HTMLElement) {
  if (!isDraggingWindow) return;
  isDraggingWindow = false;
  notch.classList.remove("is-dragging");
  try {
    targetEl.releasePointerCapture(e.pointerId);
  } catch {}
  if (windowDragMoved) {
    suppressClickUntil = Date.now() + 350;
    insideSince = Date.now();
    invoke("notch_end_move", { save: true });
  } else {
    invoke("notch_end_move", { save: false });
  }

  // Drag state baru saja berakhir: hitung target sekali lagi agar notch langsung
  // masuk mode tepi yang benar, tanpa menunggu event pointer lain.
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

// Pegangan drag pada hub
const posBar = $("notch-pos-bar");
const dragHandle = $("drag-handle");

const onDragStart = (e: PointerEvent) => {
  if ((e.target as HTMLElement).closest("#notch-reset-btn")) return;
  e.stopPropagation();
  startWindowDrag(e, dragHandle);
};

dragHandle.addEventListener("pointerdown", onDragStart);
dragHandle.addEventListener("pointermove", onWindowPointerMove);
dragHandle.addEventListener("pointerup", (e) => onWindowPointerUp(e, dragHandle));
dragHandle.addEventListener("pointercancel", (e) => onWindowPointerUp(e, dragHandle));

if (posBar) {
  posBar.addEventListener("pointerdown", onDragStart);
}

// Drag pada notch saat idle / compact atau dengan menahan Alt
notch.addEventListener("pointerdown", (e) => {
  const view = notch.dataset.view;
  const isIdleOrCompact = view === "idle" || view === "compact" || view === "clock";
  const isButton = !!(e.target as HTMLElement).closest("button");
  if (isButton) return;

  if (isIdleOrCompact || e.altKey) {
    startWindowDrag(e, notch);
  }
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
    updatePositionUI(p.custom, p.y, p.x);
  })
  .catch(() => {});

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

  if (override === "bt" || override === "dev" || override === "hud") collapse();
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
  eyes.style.setProperty("--ly", `${Math.max(-2, Math.min(1, (dy / dist) * max * k))}px`);
}
let lastPos = { dx: 0, dy: 0 };
listen<{ dx: number; dy: number }>("cursor", (e) => {
  const { dx, dy } = e.payload;
  if (Math.hypot(dx - lastPos.dx, dy - lastPos.dy) > 2) {
    lastCursorMove = Date.now();
    markActive();
  }
  lastPos = { dx, dy };
  look(dx, dy);

  // Windows: hover dihitung dari posisi global (jendela click-through tidak menerima event mouse)
  if (isWin) {
    const [hw, hh] = HIT[notch.dataset.view ?? "idle"];
    const edgeOffset = notch.classList.contains("is-edge-left") ? -10
      : notch.classList.contains("is-edge-right") ? 10 : 0;
    const notchDx = dx - edgeOffset;
    setInside(Math.abs(notchDx) <= hw / 2 && dy >= -12 && dy <= hh - 12);
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

// Tampilan ringkas di sisi layar: hanya cover album berbentuk disc berputar.
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
if (clockOn) startClock();
render();
updateBase();