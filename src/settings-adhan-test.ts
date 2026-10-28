// Tes audio adzan khusus jendela Settings.
// Disimpan sebagai src/settings-adhan-test.ts agar Vite ikut memproses aset audio
// yang berada di src/public/adzan.mp3, baik saat development maupun production build.
const ADZAN_URL = new URL("./public/adzan.mp3", import.meta.url).href;

const startButton = document.getElementById("adhan-test-start") as HTMLButtonElement | null;
const pauseButton = document.getElementById("adhan-test-pause") as HTMLButtonElement | null;
const status = document.getElementById("adhan-test-status");

if (startButton && pauseButton && status) {
    const audio = new Audio(ADZAN_URL);
    audio.preload = "auto";
    audio.volume = 0.9;

    type State = "ready" | "loading" | "playing" | "paused" | "ended" | "error";

    const setStatus = (message: string, state: State) => {
        status.textContent = message;
        status.setAttribute("data-state", state);
        pauseButton.disabled = audio.paused || audio.ended;
        startButton.disabled = state === "loading";
        startButton.textContent = state === "paused" ? "▶ Lanjutkan adzan" : "▶ Mulai tes adzan";
    };

    audio.addEventListener("playing", () => setStatus("Adzan sedang diputar", "playing"));
    audio.addEventListener("pause", () => {
        if (audio.ended || audio.currentTime === 0) setStatus("Siap diputar", "ready");
        else setStatus("Adzan dijeda", "paused");
    });
    audio.addEventListener("ended", () => setStatus("Pemutaran selesai", "ended"));
    audio.addEventListener("error", () => {
        console.error("[Settings] Gagal memuat audio adzan:", ADZAN_URL, audio.error);
        setStatus("Gagal memuat adzan.mp3 — periksa file atau hasil build", "error");
    });

    startButton.addEventListener("click", async () => {
        try {
            if (audio.ended) audio.currentTime = 0;
            if (audio.currentTime === 0) setStatus("Memuat suara adzan…", "loading");
            await audio.play();
            setStatus("Adzan sedang diputar", "playing");
        } catch (error) {
            console.error("[Settings] Tidak dapat memutar adzan:", error, ADZAN_URL);
            setStatus("Tidak dapat memutar adzan.mp3 — periksa lokasi file dan format MP3", "error");
        }
    });

    pauseButton.addEventListener("click", () => {
        if (!audio.paused && !audio.ended) audio.pause();
    });

    // Hentikan tes saat jendela Settings ditutup agar audio tidak terus bermain di belakang.
    window.addEventListener("pagehide", () => {
        audio.pause();
        audio.currentTime = 0;
    });

    setStatus("Siap diputar", "ready");
}
