// Gerakan acak saat notch menempel di dasar layar (bentuk kubah "bottomIdle"/"bottomMedia").
//
// Mesin fisika kecil (pegas + gravitasi) yang berjalan tiap frame supaya badan notch terasa seperti
// cairan/jelly: tidak ada perubahan bentuk yang meloncat, semuanya diberi "dorongan" (impuls) lalu
// dibiarkan bergoyang kembali oleh pegas yang redamannya rendah.
//
// Berkeliling: yang bergerak adalah jendela native (lewat setCx) sampai mentok di tepi layar.
// Perintah geser dikirim satu per satu (tidak menumpuk), dan sisa pecahan piksel ditutup oleh
// translate CSS supaya gerakan tidak patah-patah.
//
// Gaya dasar di bottom-play.css (membaca --bp-x/--bp-y/--bp-r/--bp-sx/--bp-sy).
// Saklar di Pengaturan > Perilaku (localStorage "notch.bottomPlay").

export type BottomPlayHooks = {
    shell: HTMLElement;
    notch: HTMLElement;
    busy: () => boolean;                    // ada hub/kartu/seretan/hover: jangan bergerak
    playing: () => boolean;                 // musik diputar: lebih sering menari
    calm: () => boolean;                    // mengantuk / baterai rendah: gerakan pelan saja
    mood: (m: string, ms: number) => void;
    getCx: () => number;                    // posisi sumbu X ketika menempel di bawah
    setCx: (cx: number) => Promise<unknown>;
    range: () => [number, number];          // rentang X saat menempel di bawah
    dock?: () => "bottom" | "left" | "right" | null;
    getTy?: () => number;                   // koordinat atas jendela saat menempel di samping
    setTy?: (ty: number) => Promise<unknown>;
    verticalRange?: () => [number, number];  // rentang Y saat menempel di samping
    hit: () => void;                        // perbarui area klik
};

const KEY = "notch.bottomPlay";
export function bottomPlayEnabled(): boolean {
    try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } // bawaan: aktif
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

/** Pegas: percepatan = -k(x - t) - c·v. Redaman kecil = bergoyang seperti jelly. */
class Spring {
    v = 0;
    constructor(public k: number, public c: number, public x = 0, public t = 0) { }
    tune(k: number, c: number) { this.k = k; this.c = c; }
    step(dt: number) { this.v += (-this.k * (this.x - this.t) - this.c * this.v) * dt; this.x += this.v * dt; }
    get rest() { return Math.abs(this.x - this.t) < 0.003 && Math.abs(this.v) < 0.03; }
}
/** Dorong pegas (bukan melompatkan nilainya) supaya bentuk berubah mulus. */
const poke = (s: Spring, amount: number) => { s.v += amount * 18; };

const G = 2600;                 // gravitasi (px/s²)
const ACC = 700;                // percepatan/perlambatan saat berkeliling (px/s²), lembut
const CANCEL = Symbol("cancel");

// [nama, bobot]
const NORMAL: [string, number][] = [["liquid", 6], ["roam", 3], ["wiggle", 2], ["squish", 2], ["sway", 2], ["dance", 1], ["yawn", 1]];
const MUSIC: [string, number][] = [["liquid", 7], ["dance", 5], ["roam", 3], ["wiggle", 2], ["squish", 1]];
const CALM: [string, number][] = [["yawn", 3], ["sway", 3], ["squish", 2], ["liquid", 1]];

const MOOD: Record<string, [string, number]> = {
    hop: ["happy", 1400], peek: ["surprised", 1200], wiggle: ["happy", 1200], roam: ["happy", 2600],
    squish: ["surprised", 900], sway: ["suspicious", 2200], dance: ["love", 1800], yawn: ["sleepy", 2400], liquid: ["happy", 1900],
};

function pick(list: [string, number][], avoid: string): string {
    const pool = list.filter(([n]) => n !== avoid);
    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [n, w] of pool) { if ((r -= w) <= 0) return n; }
    return pool[0][0];
}

export function initBottomPlay(h: BottomPlayHooks) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

    // ---------- keadaan fisika ----------
    const y = new Spring(0, 0);          // vertikal (negatif = ke atas)
    let grav = true;                     // true: gravitasi + lantai; false: mode pegas (dipakai "peek")
    const sq = new Spring(220, 9);       // penyok badan: + gepeng, - memanjang
    const wall = new Spring(220, 9);     // penyok samping saat menabrak tepi layar
    const rot = new Spring(100, 9);      // kemiringan utama (derajat)
    const px = new Spring(38, 11);       // posisi x visual notch di layar (mengikuti "wortel")
    const flow = new Spring(18, 8);      // rotasi organik yang berubah perlahan
    const float = new Spring(24, 9);     // gerak naik-turun halus seperti cairan
    let rotT = 0;                        // kemiringan yang diminta gerakan (di luar kemiringan inersia)
    let nextRippleAt = 0;                // waktu impuls cairan berikutnya
    const resetTune = () => {
        sq.tune(220, 9); wall.tune(220, 9); rot.tune(100, 9); px.tune(38, 11);
        flow.tune(18, 8); float.tune(24, 9); flow.t = 0; float.t = 0; y.tune(0, 0);
    };
    resetTune();

    let travel: null | { dest: number; carrot: number; cv: number; speed: number; edge: boolean; bumped: boolean } = null;
    let prevV = 0, axS = 0;              // percepatan halus (untuk memiringkan badan karena inersia)

    // Pengiriman posisi native dibatasi 30 fps. RAF tetap berjalan pada refresh rate layar,
    // sedangkan posisi visual dihaluskan lewat translate CSS di antara perpindahan native.
    // Target selalu di-coalesce: ketika IPC sibuk, hanya koordinat terbaru yang dikirim.
    const NATIVE_MIN_INTERVAL = 1000 / 30;
    let sent = -1, wanted = -1, inflight = false;
    let lastNativeAt = -Infinity;
    let flushTimer = 0;
    let lastHit = 0;

    let active = "";
    let last = "";
    let timer = 0;
    let raf = 0;
    let lastTs = 0;
    let waits: { ok: () => boolean; res: () => void; rej: (e: unknown) => void }[] = [];

    let enabledAt = 0, enabledVal = true; // saklar dibaca tiap 300ms, bukan tiap frame
    const enabled = () => {
        const n = performance.now();
        if (n - enabledAt > 300) { enabledAt = n; enabledVal = bottomPlayEnabled(); }
        return enabledVal;
    };
    type Dock = "bottom" | "left" | "right" | null;
    const currentDock = (): Dock => {
        if (h.dock) return h.dock();
        return h.notch.classList.contains("is-bottom") ? "bottom" : null;
    };
    const isSideDock = (dock = currentDock()) => dock === "left" || dock === "right";
    const supportedDock = () => {
        const dock = currentDock();
        const view = h.notch.dataset.view;
        if (dock === "bottom") return view === "bottomIdle" || view === "bottomMedia";
        if (dock === "left" || dock === "right") return view === "edgeIdle" || view === "edgeMedia";
        return false;
    };
    const allowed = () => enabled() && !reduced.matches && supportedDock() && !h.busy();
    const axisRange = (): [number, number] => {
        const dock = currentDock();
        if (isSideDock(dock) && h.verticalRange) return h.verticalRange();
        return h.range();
    };
    const axisPosition = (): number => {
        const dock = currentDock();
        if (isSideDock(dock)) return h.getTy?.() ?? -1;
        return h.getCx();
    };
    const setAxisPosition = (value: number): Promise<unknown> => {
        const dock = currentDock();
        if (isSideDock(dock) && h.setTy) return h.setTy(value);
        return h.setCx(value);
    };
    // ---------- menunggu (digerakkan frame, bisa dibatalkan) ----------
    const until = (ok: () => boolean) => new Promise<void>((res, rej) => { waits.push({ ok, res, rej }); });
    const wait = (ms: number) => { const t = performance.now() + ms; return until(() => performance.now() >= t); };
    // ---------- posisi native ----------
    function flush() {
        if (inflight || wanted < 0) return;
        if (wanted === sent) {
            if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
            return;
        }

        const remaining = NATIVE_MIN_INTERVAL - (performance.now() - lastNativeAt);
        if (remaining > 0) {
            if (!flushTimer) {
                flushTimer = window.setTimeout(() => {
                    flushTimer = 0;
                    flush();
                }, remaining);
            }
            return;
        }

        if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
        inflight = true;
        const target = wanted; // ambil hanya target paling baru; target yang tertinggal tidak diantrikan
        sent = target;
        lastNativeAt = performance.now();
        setAxisPosition(target).catch(() => { }).finally(() => {
            inflight = false;
            if (wanted !== sent) flush();
        });
    }
    function applyPosition() {
        const [lo, hi] = axisRange();
        wanted = Math.round(clamp(px.x, lo, hi));
        flush();
    }

    // ---------- fisika ----------
    function physics(dt: number) {
        if (grav) {
            if (y.x < 0 || y.v < 0) {
                y.v += G * dt; y.x += y.v * dt;
                if (y.x >= 0) {
                    if (y.v > 140) poke(sq, Math.min(0.26, 0.04 + y.v * 0.0003));
                    y.x = 0; y.v = y.v > 700 ? -y.v * 0.1 : 0;
                }
            }
        } else {
            y.step(dt);
        }
        sq.step(dt); wall.step(dt); rot.step(dt); px.step(dt); flow.step(dt); float.step(dt);
    }

    function stepTravel(dt: number) {
        if (!travel) return;
        const T = travel;
        const [lo, hi] = axisRange();
        T.dest = clamp(T.dest, lo, hi);
        const d = T.dest - T.carrot;
        const vd = Math.sign(d) * Math.min(T.speed, Math.sqrt(2 * ACC * Math.abs(d)));
        T.cv += clamp(vd - T.cv, -ACC * dt, ACC * dt);
        T.carrot += T.cv * dt;
        if (Math.abs(d) < 0.5 && Math.abs(T.cv) < 8) { T.carrot = T.dest; T.cv = 0; }
        px.t = T.carrot;

        // menabrak tepi layar: badan menyepit ke samping lalu membal
        if (T.edge && !T.bumped && Math.abs(px.x - T.dest) < 10 && Math.abs(px.v) > 50) {
            T.bumped = true; poke(wall, Math.min(0.24, Math.abs(px.v) * 0.0016));
        }
        if (T.carrot === T.dest && Math.abs(px.x - T.dest) < 1.5 && Math.abs(px.v) < 20) {
            px.x = T.dest; px.v = 0; travel = null;
            poke(sq, 0.1); // tiba: badan bergoyang sebentar
        }
    }

    function paint() {
        const dock = currentDock();
        const side = isSideDock(dock);
        const [lo, hi] = axisRange();
        // Pakai posisi native terbaru sebagai jangkar, lalu CSS mengisi gerakan subpiksel
        // di antara update native. Pada sisi, sumbu gerak menjadi Y, bukan X.
        const anchor = axisPosition();
        const base = clamp(anchor < 0 ? (sent < 0 ? px.x : sent) : anchor, lo, hi);
        const resid = clamp(px.x - base, -22, 22);
        const speedStretch = Math.min(0.13, Math.abs(px.v) * 0.00022);
        const ripple = flow.x;
        const pulse = clamp(float.x * 0.012, -0.025, 0.025);
        let sx: number;
        let sy: number;
        if (side) {
            // Di sisi, peregangan mengikuti gerak vertikal. Sisi luar tetap menjadi titik tumpu.
            sx = clamp(1 + sq.x * 0.60 - wall.x * 0.70 - pulse * 0.20 - speedStretch * 0.35 - ripple * 0.0015, 0.90, 1.10);
            sy = clamp(1 - sq.x * 0.72 + wall.x * 0.25 + pulse + speedStretch + ripple * 0.003, 0.90, 1.12);
        } else {
            // Di bawah, peregangan mengikuti gerak horizontal dan titik bawah tetap terkunci.
            sx = clamp(1 + sq.x * 0.72 - wall.x * 0.72 - pulse * 0.25 + speedStretch - ripple * 0.0015, 0.92, 1.12);
            sy = clamp(1 - sq.x + wall.x * 0.5 + pulse - speedStretch * 0.3 + ripple * 0.003, 0.90, 1.10);
        }
        const style = h.shell.style;
        if (side) style.setProperty("--bp-y", `${resid.toFixed(2)}px`);
        else style.setProperty("--bp-x", `${resid.toFixed(2)}px`);
        style.setProperty("--bp-sx", sx.toFixed(4));
        style.setProperty("--bp-sy", sy.toFixed(4));
    }

    const settled = () =>
        !active && !travel && !inflight && !flushTimer && wanted === sent &&
        rot.rest && sq.rest && wall.rest && flow.rest && float.rest && grav &&
        y.x === 0 && y.v === 0 && Math.abs(px.v) < 0.5 && Math.abs(rotT) < 0.02 && Math.abs(rot.x) < 0.02;

    function frame(ts: number) {
        const dt = Math.min(0.033, (ts - lastTs) / 1000 || 0.016);
        lastTs = ts;

        if (active && !allowed()) abort();

        const now = performance.now();
        // Impuls kecil acak memberi gerakan mikro terus-menerus selama animasi aktif.
        // Nilainya berubah target, bukan langsung mengubah transform, sehingga tetap lembut.
        if (active && now >= nextRippleAt) {
            const calm = h.calm();
            const strength = calm ? 0.34 : h.playing() ? 1.12 : 0.82;
            nextRippleAt = now + (calm ? rand(620, 1150) : h.playing() ? rand(180, 390) : rand(260, 650));
            flow.t = rand(-2.5, 2.5) * strength;
            float.t = rand(-1.25, 0.55) * strength;
            poke(sq, rand(-0.035, 0.05) * strength);
            if (Math.random() < 0.18) poke(wall, rand(-0.022, 0.028) * strength);
        } else if (!active) {
            flow.t = 0;
            float.t = 0;
        }

        stepTravel(dt);
        // inersia: badan condong ke belakang saat melaju, ke depan saat mengerem
        const ax = (px.v - prevV) / dt; prevV = px.v;
        axS += (ax - axS) * 0.25;
        rot.t = rotT + clamp(-axS * 0.0035 + px.v * 0.005, -10, 10);

        // Substep 12 ms cukup stabil untuk pegas yang dipakai di sini dan mengurangi kerja CPU.
        const n = Math.ceil(dt / 0.012), sub = dt / n;
        for (let i = 0; i < n; i++) physics(sub);
        if (!grav && !active && Math.abs(y.x) < 0.5 && Math.abs(y.v) < 20) { grav = true; y.x = 0; y.v = 0; }

        if (travel || Math.abs(px.v) > 0.3 || wanted !== Math.round(px.x)) applyPosition();
        // Hitbox tidak perlu diperbarui tiap frame; 4x/detik cukup untuk pergerakan horizontal.
        if (travel && now - lastHit > 250) { lastHit = now; h.hit(); }
        paint();

        const ready = waits.filter((w) => w.ok());
        if (ready.length) { waits = waits.filter((w) => !ready.includes(w)); ready.forEach((w) => w.res()); }

        if (settled()) { finish(); return; }
        raf = requestAnimationFrame(frame);
    }

    function startLoop() {
        if (raf) return;
        lastTs = performance.now(); prevV = px.v; axS = 0;
        raf = requestAnimationFrame(frame);
    }

    function finish() {
        raf = 0;
        if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
        h.shell.removeAttribute("data-play");
        h.shell.removeAttribute("data-play-axis");
        for (const v of ["--bp-x", "--bp-y", "--bp-r", "--bp-sx", "--bp-sy"]) h.shell.style.removeProperty(v);
        resetTune(); rotT = 0;
        h.hit();
    }

    // dibatalkan (hover, kartu, seretan, saklar mati): berhenti mengerem halus di tempat
    function abort() {
        const ws = waits; waits = [];
        ws.forEach((w) => w.rej(CANCEL));
        active = "";
        travel = null;
        px.t = px.x; px.tune(90, 22);
        sq.t = 0; wall.t = 0; rotT = 0;
        sq.tune(220, 12); rot.tune(160, 16);
        if (!grav) { y.tune(160, 20); y.t = 0; }
        flow.t = 0; float.t = 0;
        schedule(1500);
    }

    // ---------- gerakan ----------
    const travelTo = (dest: number, edge: boolean, speed: [number, number] = [260, 420]) => {
        travel = { dest, carrot: px.x, cv: 0, speed: rand(speed[0], speed[1]), edge, bumped: false };
        return until(() => !travel);
    };

    const TRICKS: Record<string, () => Promise<void>> = {
        // menekuk perlahan, melenting dengan gravitasi, mendarat gepeng lalu bergoyang
        async hop() {
            // Rebound bentuk tanpa mengangkat badan dari tepi yang ditempeli.
            sq.t = 0.16; await wait(140);
            sq.t = -0.08; poke(sq, -0.07); await wait(180);
            sq.t = 0; poke(sq, 0.025); await wait(220);
        },
        // meluncur ke bawah layar, sembunyi sebentar, lalu muncul kaget
        async peek() {
            // Peek digambarkan dengan penyusutan singkat, bukan gerakan menjauh dari tepi.
            sq.t = 0.12; await wait(260);
            sq.t = -0.10; poke(sq, -0.06); await wait(320);
            sq.t = 0; await wait(220);
        },
        async wiggle() {
            rot.tune(200, 11);
            for (const a of [-7, 7, -6, 5, -3.5, 2, 0]) {
                rotT = a;
                flow.t = a * 0.32;
                poke(sq, Math.sign(a) * 0.012);
                await wait(110);
            }
            flow.t = 0;
        },
        // mengembang-mengempis seperti agar-agar
        async squish() {
            for (const a of [0.15, -0.13, 0.1, -0.07, 0.04]) { poke(sq, a); await wait(300); }
            await wait(200);
        },
        // mengayun pelan
        async sway() {
            rot.tune(36, 7);
            for (const a of [-4.5, 4.5, -2, 0]) {
                rotT = a;
                flow.t = a * 0.22;
                await wait(560);
            }
            flow.t = 0;
            await wait(300);
        },
        // ikut ketukan: miring kiri-kanan sambil memantul kecil
        async dance() {
            rot.tune(180, 12);
            for (let i = 0; i < 8; i++) {
                rotT = i % 2 ? 3.2 : -3.2; poke(sq, 0.06); flow.t = i % 2 ? 1.2 : -1.2;
                await wait(210);
            }
            rotT = 0; await wait(250);
        },
        // meregang ke atas pelan-pelan, lalu lemas
        async yawn() {
            sq.tune(50, 9); sq.t = -0.15; await wait(950);
            sq.tune(220, 9); sq.t = 0; await wait(600);
        },
        // Mengalir ke titik-titik acak, kadang berubah arah dan sedikit mengembang saat berbelok.
        // Tidak wajib pulang ke posisi awal agar pola terasa hidup, bukan animasi bolak-balik.
        async liquid() {
            const [lo, hi] = axisRange();
            const span = hi - lo;
            if (axisPosition() < 0 || span < 140) {
                await TRICKS.squish();
                await TRICKS.sway();
                return;
            }

            const calm = h.calm();
            const strength = calm ? 0.55 : h.playing() ? 1.15 : 1;
            const steps = Math.floor(rand(calm ? 2 : 3, calm ? 4 : 7));
            let direction = Math.random() < 0.5 ? -1 : 1;

            for (let i = 0; i < steps; i++) {
                const from = clamp(px.x, lo, hi);
                if (Math.random() < (calm ? 0.22 : 0.38)) direction *= -1;

                const distance = rand(span * (calm ? 0.045 : 0.085), span * (calm ? 0.13 : 0.23));
                let dest = clamp(from + direction * distance + rand(-span * 0.035, span * 0.035), lo, hi);
                if (Math.abs(dest - from) < Math.min(42, span * 0.06)) {
                    direction = from < (lo + hi) / 2 ? 1 : -1;
                    dest = clamp(from + direction * rand(span * 0.08, span * 0.16), lo, hi);
                }

                let edge = dest <= lo + 1 || dest >= hi - 1;
                // Sebagian besar gerak berbelok sebelum tepi, sesekali menyentuh tepi untuk efek pantul.
                if (edge && Math.random() < 0.58) {
                    dest = clamp(dest + (dest <= lo + 1 ? 1 : -1) * rand(18, 46), lo, hi);
                    edge = false;
                }

                await travelTo(dest, edge, calm ? [95, 180] : [155, 320]);
                poke(sq, rand(0.03, 0.085) * strength);
                flow.t = rand(-2.8, 2.8) * strength;
                float.t = rand(-1.1, 0.45) * strength;
                if (Math.random() < (calm ? 0.12 : 0.34)) rotT = rand(-4.2, 4.2) * strength;
                await wait(rand(calm ? 200 : 75, calm ? 380 : 245));

                // Riak bentuk kecil ketika berhenti sejenak. Saat mode tenang tidak ada lompatan.
                if (!calm && Math.random() < 0.34) {
                    sq.t = rand(0.035, 0.095);
                    await wait(rand(85, 165));
                    sq.t = 0;
                }
                if (!calm && Math.random() < 0.22) {
                    // Riak kecil berupa gepeng-melebar, bukan lompatan vertikal.
                    sq.t = rand(0.045, 0.095);
                    flow.t = rand(-2.2, 2.2) * strength;
                    poke(sq, rand(0.008, 0.025));
                    await wait(rand(100, 180));
                    sq.t = 0;
                }
            }

            rotT = 0;
            sq.t = 0;
        },
        // meluncur ke posisi acak (kadang sampai mentok di tepi layar), lalu pulang
        async roam() {
            const [lo, hi] = axisRange();
            const home = axisPosition();
            if (home < 0 || hi - lo < 160) { await TRICKS.wiggle(); return; }
            const legs = Math.random() < 0.4 ? 2 : 1;
            for (let i = 0; i < legs; i++) {
                const r = Math.random();
                let dest = r < 0.3 ? lo : r < 0.6 ? hi : rand(lo, hi);
                if (Math.abs(dest - px.x) < 120) dest = px.x < (lo + hi) / 2 ? hi : lo;
                await travelTo(dest, dest === lo || dest === hi);
                h.mood("happy", 1400);
                await wait(rand(500, 1100));
                await (Math.random() < 0.5 ? TRICKS.squish() : TRICKS.wiggle());
            }
            await travelTo(clamp(home, lo, hi), false);
            await wait(250);
        },
    };

    function schedule(ms?: number) {
        window.clearTimeout(timer);
        const delay = h.calm() ? rand(4800, 8500) : h.playing() ? rand(1350, 3300) : rand(2200, 6200);
        timer = window.setTimeout(tick, ms ?? delay);
    }

    function tick() {
        if (active) { schedule(500); return; }
        if (!allowed()) { schedule(1500); return; }
        run(pick(h.calm() ? CALM : h.playing() ? MUSIC : NORMAL, last));
    }

    async function run(name: string) {
        last = active = name;
        grav = true; y.x = 0; y.v = 0; rotT = 0;
        const dock = currentDock();
        const side = isSideDock(dock);
        const position = axisPosition();
        const [lo, hi] = axisRange();
        px.x = px.t = position < 0 ? 0 : clamp(position, lo, hi);
        px.v = 0;
        sent = wanted = position < 0 ? -1 : Math.round(position);
        lastNativeAt = -Infinity;
        if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = 0; }
        h.shell.dataset.play = name;
        h.shell.dataset.playAxis = side ? "side" : "bottom";
        // Masing-masing orientasi mengunci sumbu yang tidak digunakan, agar badan tidak terangkat
        // dari bawah atau terlepas dari sisi saat melakukan efek liquid.
        h.shell.style.setProperty("--bp-x", "0px");
        h.shell.style.setProperty("--bp-y", "0px");
        h.shell.style.setProperty("--bp-r", "0deg");
        nextRippleAt = performance.now() + rand(100, 320);
        flow.t = 0; float.t = 0;
        const [m, ms] = MOOD[name];
        h.mood(m, ms);
        startLoop();
        try {
            await TRICKS[name]();
        } catch (e) {
            if (e !== CANCEL) console.error(e);
            return; // dibatalkan: abort() sudah merapikan dan menjadwalkan ulang
        }
        active = "";
        sq.t = 0; wall.t = 0; rotT = 0;
        schedule();
    }

    schedule(4000);
}
