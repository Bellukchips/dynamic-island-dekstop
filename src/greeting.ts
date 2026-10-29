// Greeting di jendela utama Notch. Dua sumber sapaan, satu layer tampilan (.l-greeting di index.html):
//  1. Saat aplikasi dijalankan (juga setelah komputer restart): baca pilihan dari Pengaturan
//     (localStorage "notch.startupGreeting"), tampilkan kartu teks dan ucapkan dengan TTS id-ID.
//  2. Tombol "▶ Coba ucapkan" di Pengaturan: jendela Settings yang berbicara, lalu mengirim event
//     "greeting-start" {id, text, subtitle, durationMs} dan "greeting-end" {id}. Di sini cukup
//     menampilkan / menutup kartunya (tanpa berbicara lagi agar tidak dobel).
import { listen } from "@tauri-apps/api/event";

export type GreetingHooks = {
  canShow: () => boolean;                 // tidak sedang ada kartu/hub lain
  isCard: () => boolean;                  // kartu "dev" sedang aktif (bukan hub/kartu lain)
  show: (ms: number) => void;             // tampilkan kartu "dev" selama ms
  mood: (m: string, ms: number) => void;  // ekspresi mata sementara
};
export type GreetingApi = {
  // kartu teks yang sama dipakai Conversation Moments / Focus Companion (menimpa kartu "dev" yang sedang tampil)
  say: (text: string, sub: string, ms: number) => void;
};
type StartPayload = { id?: string; text?: string; subtitle?: string; durationMs?: number };
type EndPayload = { id?: string };
type Pref = { enabled: boolean; mode: string; custom_text: string };

// harus sama dengan settings.html
const STARTUP_GREETING_KEY = "notch.startupGreeting";
const MODES = ["auto", "halo", "morning", "noon", "afternoon", "evening", "custom"];
const DEFAULT: Pref = { enabled: true, mode: "auto", custom_text: "Halo, semangat menjalani hari!" };

function readPref(): Pref {
  try {
    const saved = JSON.parse(localStorage.getItem(STARTUP_GREETING_KEY) || "null");
    if (!saved || typeof saved !== "object") return { ...DEFAULT };
    return {
      enabled: saved.enabled !== false,
      mode: MODES.includes(saved.mode) ? saved.mode : "auto",
      custom_text: typeof saved.custom_text === "string" ? saved.custom_text.slice(0, 120) : DEFAULT.custom_text,
    };
  } catch { return { ...DEFAULT }; }
}

function greetingText(pref: Pref, d = new Date()): string {
  if (pref.mode === "custom") return pref.custom_text.trim() || DEFAULT.custom_text;
  if (pref.mode === "halo") return "Halo!";
  if (pref.mode === "morning") return "Selamat pagi!";
  if (pref.mode === "noon") return "Selamat siang!";
  if (pref.mode === "afternoon") return "Selamat sore!";
  if (pref.mode === "evening") return "Selamat malam!";
  const h = d.getHours();
  const part = h >= 4 && h < 11 ? "pagi" : h >= 11 && h < 15 ? "siang" : h >= 15 && h < 18 ? "sore" : "malam";
  return `Halo! Selamat ${part}!`;
}
const estimateMs = (text: string) => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(11000, Math.max(3500, 1800 + words * 470));
};

// ---------- suara ----------
const findIndonesianVoice = (voices: SpeechSynthesisVoice[]) =>
  voices.find((v) => /^id(?:[-_]|$)/i.test(v.lang) || /(?:bahasa\s+indonesia|indonesian)/i.test(v.name)) ?? null;

// Tepat setelah boot / start, daftar suara Windows sering kosong beberapa detik. Tunggu sampai
// suara Indonesia muncul (polling + "voiceschanged"), bukan menyerah pada pengecekan pertama.
function waitForIndonesianVoice(timeoutMs = 9000): Promise<SpeechSynthesisVoice | null> {
  const synth = window.speechSynthesis;
  return new Promise((resolve) => {
    const check = () => {
      const v = findIndonesianVoice(synth.getVoices());
      if (v) { cleanup(); resolve(v); }
    };
    const poll = window.setInterval(check, 300);
    const timer = window.setTimeout(() => { cleanup(); resolve(findIndonesianVoice(synth.getVoices())); }, timeoutMs);
    function cleanup() { clearInterval(poll); clearTimeout(timer); synth.removeEventListener("voiceschanged", check); }
    synth.addEventListener("voiceschanged", check);
    check();
  });
}

async function speak(text: string): Promise<{ ok: boolean; reason: string }> {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return { ok: false, reason: "Web Speech tidak tersedia" };
  const voice = await waitForIndonesianVoice();
  if (!voice) {
    const list = synth.getVoices().map((v) => `${v.name} (${v.lang})`).join(", ") || "belum ada voice yang dimuat";
    return { ok: false, reason: `voice id-ID tidak ditemukan; tersedia: ${list}` };
  }
  return new Promise((resolve) => {
    let started = false, done = false;
    const finish = (r: { ok: boolean; reason: string }) => { if (!done) { done = true; clearTimeout(watchdog); clearTimeout(hard); resolve(r); } };
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "id-ID"; u.voice = voice; u.rate = 0.95; u.pitch = 1.04;
    u.onstart = () => { started = true; };
    u.onend = () => finish({ ok: true, reason: "" });
    u.onerror = (e) => finish({ ok: false, reason: e.error || "error" });
    const watchdog = window.setTimeout(() => {
      if (!started && !synth.speaking && !synth.pending) finish({ ok: false, reason: "audio tidak mulai diputar" });
    }, 7000);
    const hard = window.setTimeout(() => finish({ ok: true, reason: "" }), 30000);
    try { synth.cancel(); synth.resume(); synth.speak(u); }
    catch (error) { finish({ ok: false, reason: String(error) }); }
  });
}

// ---------- jendela utama ----------
let started = false;
export function initGreeting(h: GreetingHooks): GreetingApi | null {
  if (started) return null; // idempoten
  started = true;
  const notch = document.getElementById("notch");
  const textEl = document.getElementById("greeting-text");
  const subEl = document.getElementById("greeting-sub");
  if (!notch || !textEl || !subEl) { console.warn("[Greeting] Layer greeting tidak ada di index.html"); return null; }
  let activeId = "";
  let clearTimer: number | undefined;

  const scheduleClear = (ms: number) => {
    clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => notch.classList.remove("greeting-active"), ms);
  };
  function showCard(id: string, text: string, sub: string, ms: number) {
    activeId = id;
    textEl!.textContent = text;
    subEl!.textContent = sub;
    notch!.classList.add("greeting-active");
    h.show(ms);
    h.mood("happy", ms);
    scheduleClear(ms + 600);
  }
  function endCard(id?: string) {
    if (id && activeId && id !== activeId) return;           // sapaan lain sudah menggantikan
    if (!notch!.classList.contains("greeting-active")) return;
    activeId = "";
    if (h.isCard()) h.show(900);                              // beri jeda singkat lalu tutup
    scheduleClear(1500);
  }

  // dari tombol "Coba ucapkan" di Pengaturan
  listen<StartPayload>("greeting-start", (e) => {
    const p = e.payload ?? {};
    const text = String(p.text ?? "").trim();
    if (!text) return;
    const ms = Math.min(15000, Math.max(2500, Math.round(Number(p.durationMs)) || estimateMs(text)));
    showCard(String(p.id ?? `ext-${Date.now()}`), text, p.subtitle || "Sapaan dari Notch", ms);
  }).catch((error) => console.warn("[Greeting] Gagal memasang listener greeting-start:", error));
  listen<EndPayload>("greeting-end", (e) => endCard(e.payload?.id))
    .catch((error) => console.warn("[Greeting] Gagal memasang listener greeting-end:", error));

  // sapaan saat aplikasi dijalankan. Setelah boot/login bisa ada kartu lain yang tampil atau jendela
  // belum siap, jadi coba lagi beberapa kali.
  let tries = 0;
  const attempt = () => {
    const pref = readPref();
    if (!pref.enabled) return;
    if (!h.canShow()) {
      if (++tries <= 15) window.setTimeout(attempt, 2000);
      else console.warn("[Greeting] Dilewati: notch terus sibuk");
      return;
    }
    const text = greetingText(pref);
    const sub = new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
    showCard("startup", text, sub, estimateMs(text) + 1800);
    void speak(text).then((r) => {
      if (!r.ok) console.warn("[Greeting] Suara gagal:", r.reason);
      endCard("startup");
    });
  };
  window.setTimeout(attempt, 2000);

  return { say: (text, sub, ms) => showCard(`msg-${Date.now()}`, text, sub, ms) };
}
