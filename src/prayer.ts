import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Vite akan mengemas aset ini dari src/public/adzan.mp3 ke URL yang benar saat build.
const ADZAN_URL = new URL("./public/adzan.mp3", import.meta.url).href;

// Halaman jadwal shalat + pengingat. Data dari Rust (prayer_month), semua hitungan di sini.

type Day = {
    tanggal: number; imsak: string; subuh: string; terbit: string;
    dzuhur: string; ashar: string; maghrib: string; isya: string;
};
type Mode = "adzan" | "tone" | "silent";
type Prefs = { provinsi: string; kabkota: string; mode: Mode; remind_before: boolean; remind_min: number };
type Entry = { key: string; name: string; at: Date };
type Hooks = {
    card: (title: string, sub: string, ms: number) => void;
    mood: (m: string, ms: number) => void;
};

const PRAYERS: [keyof Day, string][] = [
    ["subuh", "Subuh"], ["dzuhur", "Dzuhur"], ["ashar", "Ashar"], ["maghrib", "Maghrib"], ["isya", "Isya"],
];
const ARC_X = [30, 90, 150, 210, 270];
const ARC_Y = [24, 12, 8, 12, 24];

let prefs: Prefs | null = null;
let hooks: Hooks;
let err = "";
let force = false; // tombol "Muat ulang": lewati cache sekali
const months = new Map<string, Day[]>();
const attempts = new Map<string, number>();

const el = (id: string) => document.getElementById(id);
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mkey = (y: number, m: number) => `${y}-${m}`;

// ---------- data ----------
function ensureMonth(y: number, m: number) {
    if (!prefs) return;
    const k = mkey(y, m);
    if (months.has(k)) return;
    if (Date.now() - (attempts.get(k) ?? 0) < 30_000) return; // jangan menembak API terus-menerus
    attempts.set(k, Date.now());
    const refresh = force;
    force = false;
    invoke<Day[]>("prayer_month", {
        provinsi: prefs.provinsi, kabkota: prefs.kabkota, year: y, month: m, refresh,
    })
        .then((d) => { months.set(k, d); err = ""; render(); })
        .catch((e) => { err = String(e); render(); });
}

function parseAt(base: Date, s: string): Date | null {
    const m = /(\d{1,2})[:.](\d{2})/.exec(s ?? "");
    if (!m) return null;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), +m[1], +m[2], 0);
}

function dayEntries(d: Date): { list: Entry[]; day: Day } | null {
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    const days = months.get(mkey(y, mo));
    if (!days) { ensureMonth(y, mo); return null; }
    const day = days.find((x) => x.tanggal === d.getDate()) ?? days[d.getDate() - 1];
    if (!day) return null;
    const list: Entry[] = [];
    for (const [k, name] of PRAYERS) {
        const at = parseAt(d, day[k] as string);
        if (at) list.push({ key: k, name, at });
    }
    return list.length ? { list, day } : null;
}

type Next = Entry & { tomorrow: boolean; entries: Entry[]; day: Day };
function nextPrayer(): Next | null {
    const now = new Date();
    const t = dayEntries(now);
    if (t) {
        const e = t.list.find((x) => x.at > now);
        if (e) return { ...e, tomorrow: false, entries: t.list, day: t.day };
    }
    const tm = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const x = dayEntries(tm);
    if (x) return { ...x.list[0], tomorrow: true, entries: x.list, day: x.day };
    return null;
}

// ---------- tampilan ----------
function build() {
    const arc = el("pr-arc");
    if (!arc || arc.dataset.built) return;
    arc.dataset.built = "1";
    const dots = ARC_X.map((x, i) =>
        `<circle class="pr-ring" id="pr-r${i}" cx="${x}" cy="${ARC_Y[i]}" r="8"/>` +
        `<circle class="pr-dot" id="pr-d${i}" cx="${x}" cy="${ARC_Y[i]}" r="3.5"/>`).join("");
    const labels = PRAYERS.map(([, n], i) =>
        `<div class="pr-col" id="pr-c${i}"><span>${n}</span><b id="pr-t${i}">--:--</b></div>`).join("");
    arc.innerHTML =
        `<svg viewBox="0 0 300 34"><path class="pr-path" d="M30 24 Q150 -8 270 24"/>${dots}</svg>` +
        `<div class="pr-labels">${labels}</div>`;
}

function render() {
    const count = el("pr-count");
    if (!count) return; // halaman dimatikan
    build();
    const set = (id: string, t: string) => { const e = el(id); if (e) e.textContent = t; };

    set("pr-city", prefs?.kabkota ?? "-");
    set("pr-src", err ? `Gagal: ${err}`.slice(0, 40) : "Dari config");
    el("pr-src")?.classList.toggle("bad", !!err);

    const n = nextPrayer();
    if (!n) {
        set("pr-name", err ? "Offline" : "Memuat…");
        count.textContent = "--:--:--";
        set("pr-at", "");
        set("pr-when", "");
        set("pr-meta", "");
    } else {
        const s = Math.max(0, Math.floor((n.at.getTime() - Date.now()) / 1000));
        count.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
        set("pr-name", n.name);
        set("pr-at", hhmm(n.at));
        set("pr-when", n.tomorrow ? "besok" : "hari ini");
        set("pr-meta", `Imsak ${n.day.imsak} · Terbit ${n.day.terbit}`);
        const idx = n.entries.findIndex((e) => e.key === n.key);
        n.entries.forEach((e, i) => {
            set(`pr-t${i}`, hhmm(e.at));
            el(`pr-c${i}`)?.classList.toggle("next", i === idx);
            el(`pr-c${i}`)?.classList.toggle("past", !n.tomorrow && i < idx);
            el(`pr-d${i}`)?.classList.toggle("next", i === idx);
            el(`pr-d${i}`)?.classList.toggle("past", !n.tomorrow && i < idx);
            el(`pr-r${i}`)?.classList.toggle("on", i === idx);
        });
    }

    if (prefs) {
        document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) =>
            b.classList.toggle("on", b.dataset.mode === prefs!.mode));
        el("pr-remind")?.classList.toggle("on", prefs.remind_before);
        set("pr-remind-txt", `${prefs.remind_min} mnt sebelum`);
    }
}

// ---------- suara ----------
let ctx: AudioContext | null = null;
function tone(times: number) {
    try {
        ctx ??= new AudioContext();
        if (ctx.state === "suspended") void ctx.resume();
        const t0 = ctx.currentTime;
        for (let i = 0; i < times; i++) {
            [660, 880].forEach((f, j) => {
                const o = ctx!.createOscillator(), g = ctx!.createGain();
                const t = t0 + i * 0.9 + j * 0.28;
                o.type = "sine"; o.frequency.value = f;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
                o.connect(g).connect(ctx!.destination);
                o.start(t); o.stop(t + 0.52);
            });
        }
    } catch { /* audio tidak tersedia: kartu tetap tampil */ }
}
// File suara berada di src/public/adzan.mp3. ADZAN_URL diproses Vite agar
// path tetap benar baik saat npm run dev maupun saat aplikasi dibuild.
let adzanAudio: HTMLAudioElement | null = null;
function adzan() {
    let fallbackPlayed = false;
    const fallbackTone = () => {
        if (fallbackPlayed) return;
        fallbackPlayed = true;
        tone(3);
    };

    try {
        const audio = adzanAudio ??= new Audio(ADZAN_URL);
        audio.preload = "auto";
        audio.volume = 0.9;
        audio.onerror = () => {
            console.error("[Prayer] Gagal memuat file adzan:", ADZAN_URL, audio.error);
            fallbackTone();
        };

        // Mulai dari awal apabila pratinjau atau audio sebelumnya masih berjalan.
        audio.pause();
        try { audio.currentTime = 0; } catch { /* metadata mungkin belum dimuat */ }

        const playback = audio.play();
        if (playback) {
            void playback.catch((error: unknown) => {
                console.error("[Prayer] Gagal memutar suara adzan:", error, ADZAN_URL);
                fallbackTone();
            });
        }
    } catch (error) {
        console.error("[Prayer] Audio adzan tidak tersedia:", error, ADZAN_URL);
        fallbackTone();
    }
}

// ---------- pengingat ----------
const FIRED_KEY = "notch.prayer.fired";
let fired = new Set<string>();
try { fired = new Set(JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]")); } catch { /* abaikan */ }
const markFired = (k: string) => {
    fired.add(k);
    try { localStorage.setItem(FIRED_KEY, JSON.stringify([...fired].slice(-60))); } catch { /* abaikan */ }
};

function checkReminders() {
    if (!prefs) return;
    const now = new Date();
    const today = dayEntries(now);
    const tm = dayEntries(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const cands = [...(today?.list ?? []), ...(tm ? [tm.list[0]] : [])]; // Subuh besok ikut (pengingat lewat tengah malam)
    const nowMs = now.getTime();

    for (const c of cands) {
        for (const kind of ["pre", "at"] as const) {
            if (kind === "pre" && !prefs.remind_before) continue;
            const trig = c.at.getTime() - (kind === "pre" ? prefs.remind_min * 60_000 : 0);
            if (nowMs < trig || nowMs >= trig + 90_000) continue; // jendela 90 dtk: tidak menembak ulang saat app dibuka telat
            const k = `${c.at.toDateString()}|${c.key}|${kind}`;
            if (fired.has(k)) continue;
            markFired(k);

            if (kind === "pre") {
                hooks.card(`Menjelang ${c.name}`, `${prefs.remind_min} menit lagi · ${hhmm(c.at)}`, 8000);
                hooks.mood("surprised", 3000);
                if (prefs.mode !== "silent") tone(1);
            } else {
                hooks.card(`Waktu ${c.name}`, `${hhmm(c.at)} · ${prefs.kabkota}`, 15000);
                hooks.mood("love", 4000);
                if (prefs.mode === "adzan") adzan();
                else if (prefs.mode === "tone") tone(3);
            }
        }
    }
}

// ---------- kontrol ----------
function savePrefs() {
    if (!prefs) return;
    invoke("prayer_set_prefs", {
        mode: prefs.mode, remindBefore: prefs.remind_before, remindMin: prefs.remind_min,
    }).catch(() => { });
}

function wire() {
    document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) =>
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!prefs) return;
            prefs.mode = b.dataset.mode as Mode;
            if (prefs.mode === "adzan") adzan(); else if (prefs.mode === "tone") tone(1); // pratinjau suara
            render(); savePrefs();
        }));
    el("pr-remind")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!prefs) return;
        prefs.remind_before = !prefs.remind_before;
        render(); savePrefs();
    });
    el("pr-refresh")?.addEventListener("click", (e) => {
        e.stopPropagation();
        months.clear(); attempts.clear(); err = ""; force = true;
        render();
    });
}

export function initPrayer(h: Hooks) {
    hooks = h;
    wire();
    build();

    invoke<Prefs>("prayer_info").then((p) => { prefs = p; render(); }).catch((e) => { err = String(e); render(); });

    // lokasi / pilihan berubah dari jendela pengaturan atau config.toml
    listen<{ prayer?: Prefs }>("config-changed", (e) => {
        const p = e.payload?.prayer;
        if (!p) return;
        const moved = !prefs || p.provinsi !== prefs.provinsi || p.kabkota !== prefs.kabkota;
        prefs = p;
        if (moved) { months.clear(); attempts.clear(); err = ""; }
        render();
    });

    setInterval(() => { render(); checkReminders(); }, 1000);
}
