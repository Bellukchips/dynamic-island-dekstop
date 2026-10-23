// Pesan imut saat pointer lama tidak bergerak ("Kamu kemana, kok diam saja?").
// Seluruh logika ada di sini; main.ts hanya menyediakan beberapa pengait (lihat NudgeHooks).
import { listen } from "@tauri-apps/api/event";
// gaya ada di src/nudge.css, dipasang lewat <link> di index.html (sama seperti styles.css)

export type NudgeCfg = {
    enabled: boolean;
    idle_min: number;      // menit pointer diam sebelum pesan muncul
    message: string;
    emoji: string;         // satu atau beberapa emoji (maks MAX_EMOJI yang ditampilkan)
    mood: string;          // ekspresi mata saat pesan tampil
    show_ms: number;       // lama pesan tampil
    only_silent: boolean;  // jangan muncul saat musik/video diputar
};

export type NudgeHooks = {
    lastMove: () => number;                              // waktu (ms epoch) gerakan pointer terakhir
    playing: () => boolean;                              // sedang ada musik/video
    canShow: () => boolean;                              // tidak sedang menampilkan sesuatu yang lain
    card: (title: string, sub: string, ms: number) => void;
    mood: (m: string, ms: number) => void;
};

const DEFAULT: NudgeCfg = {
    enabled: true,
    idle_min: 2,
    message: "Kamu kemana, kok diam saja?",
    emoji: "🥺",
    mood: "sad",
    show_ms: 6000,
    only_silent: true,
};
const MOODS = ["normal", "happy", "sleepy", "surprised", "angry", "love", "suspicious", "sad"];
const MAX_EMOJI = 5; // jumlah emoji yang muat di ikon kartu
const MOOD_AFTER_MS = 5000; // ekspresi mata bertahan segini lama setelah kartu pesan menutup

// Pecah teks jadi emoji satuan. Urutan gabungan (mis. 👨‍👩‍👧 atau bendera) dihitung satu emoji,
// dan spasi dibuang. Memakai Intl.Segmenter bila ada; kalau tidak, per karakter.
function splitEmoji(text: string): string[] {
    const Seg = (Intl as any).Segmenter;
    const parts: string[] = Seg
        ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s: any) => s.segment as string)
        : Array.from(text);
    return parts.filter((p) => p.trim()).slice(0, MAX_EMOJI);
}

// nilai dari config bisa kosong / di luar batas: rapikan supaya selalu aman dipakai
function clean(raw: Partial<NudgeCfg> | undefined | null): NudgeCfg {
    const c: NudgeCfg = { ...DEFAULT, ...(raw ?? {}) };
    c.enabled = !!c.enabled;
    c.only_silent = !!c.only_silent;
    c.idle_min = Math.min(240, Math.max(1, Math.round(Number(c.idle_min)) || DEFAULT.idle_min));
    c.show_ms = Math.min(30000, Math.max(2000, Math.round(Number(c.show_ms)) || DEFAULT.show_ms));
    c.message = String(c.message ?? "").trim().slice(0, 80) || DEFAULT.message;
    c.emoji = splitEmoji(String(c.emoji ?? "")).join("") || DEFAULT.emoji;
    if (!MOODS.includes(c.mood)) c.mood = DEFAULT.mood;
    return c;
}

export function initNudge(h: NudgeHooks) {
    let cfg = clean((window as any).__CFG__?.nudge);
    const startedAt = Date.now(); // pointer yang belum pernah bergerak dihitung diam sejak aplikasi mulai
    let shownAt = 0;              // 0 = belum muncul di periode diam ini

    function fire(c: NudgeCfg, minutes: number) {
        h.card(c.message, minutes > 0 ? `Pointer diam ${minutes} menit` : "Ini contoh pesan", c.show_ms);

        // ganti ikon kartu dengan emoji yang bergoyang bergantian
        const icon = document.getElementById("dev-icon");
        if (icon) {
            const parts = splitEmoji(c.emoji);
            icon.dataset.kind = "nudge";
            icon.dataset.count = String(parts.length);
            icon.replaceChildren(
                ...parts.map((ch, i) => {
                    const span = document.createElement("span");
                    span.className = "emo";
                    span.style.setProperty("--i", String(i)); // jeda animasi per emoji
                    span.textContent = ch;
                    return span;
                })
            );
        }
        // mulai ulang animasi muncul setiap kali pesan tampil
        const layer = document.querySelector<HTMLElement>(".l-dev");
        if (layer) {
            layer.classList.remove("nudge-in");
            void layer.offsetWidth;
            layer.classList.add("nudge-in");
        }
        // Mata hanya terlihat saat notch dalam tampilan idle, sedangkan kartu pesan menggantikannya.
        // Ekspresi dipertahankan beberapa detik setelah kartu menutup supaya sempat terlihat.
        h.mood(c.mood, c.show_ms + MOOD_AFTER_MS);
    }

    setInterval(() => {
        const now = Date.now();
        const last = Math.max(h.lastMove(), startedAt);

        // pointer bergerak lagi setelah pesan muncul: sapa balik, lalu siap untuk periode diam berikutnya
        if (shownAt && last >= shownAt) {
            shownAt = 0;
            h.mood("happy", 2000);
        }

        if (!cfg.enabled || shownAt) return;
        const idle = now - last;
        if (idle < cfg.idle_min * 60_000) return;
        if (cfg.only_silent && h.playing()) return;
        if (!h.canShow()) return; // ada kartu/hub yang sedang tampil: coba lagi nanti

        shownAt = now;
        fire(cfg, Math.max(1, Math.floor(idle / 60_000)));
    }, 2000);

    // perubahan dari jendela pengaturan berlaku langsung
    listen<{ nudge?: Partial<NudgeCfg> }>("config-changed", (e) => {
        if (!e.payload?.nudge) return;
        const next = clean(e.payload.nudge);
        // pratinjau ekspresi: mata berubah sebentar begitu pilihan diganti di pengaturan
        if (next.mood !== cfg.mood) h.mood(next.mood, 3500);
        cfg = next;
    });
    // tombol "Coba tampilkan" di pengaturan
    listen<Partial<NudgeCfg>>("nudge-test", (e) => fire(clean(e.payload), 0));
    // tes cepat dari keyboard (seperti tombol demo lain di main.ts)
    document.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) fire(cfg, 0);
    });
}