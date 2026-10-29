// Awan percakapan untuk Conversation Moments + Focus Companion saat notch menempel di
// SISI KIRI atau DASAR layar. Di posisi itu pesan tidak mengubah notch menjadi kartu lebar;
// notch tetap berbentuk bubble dan pesan muncul sebagai awan yang ekornya mengarah ke notch.
//
// Ringan: satu elemen DOM, hanya opacity + scale yang dianimasikan (compositor), tidak ada
// loop per-frame, dan pengukuran layout hanya sekali setiap pesan muncul.
// Gaya ada di bottom-play.css (kelas .moment-bubble).

export type MomentBubbleHooks = {
  shell: HTMLElement;
  notch: HTMLElement;
};

export type MomentBubble = {
  /** Tampilkan awan. Mengembalikan false bila notch tidak di kiri/bawah (pakai kartu biasa). */
  show: (text: string, sub: string, ms: number) => boolean;
  hide: () => void;
  /** Awan menempel (adzan): tidak hilang oleh timer/hover, hanya oleh hideSticky(). false bila notch tidak di kiri/bawah. */
  showSticky: (text: string, sub: string) => boolean;
  hideSticky: () => void;
  active: () => boolean;
};

// Sisi kanan memakai kartu biasa seperti sebelumnya; ubah ke true bila ingin awan juga di kanan.
const BUBBLE_ON_RIGHT = false;

type Side = "bottom" | "left" | "right";

export function initMomentBubble({ shell, notch }: MomentBubbleHooks): MomentBubble {
  const el = document.createElement("div");
  el.className = "moment-bubble";
  el.setAttribute("aria-hidden", "true");
  const textEl = document.createElement("div");
  textEl.className = "mb-text";
  const subEl = document.createElement("div");
  subEl.className = "mb-sub";
  el.append(textEl, subEl);
  shell.appendChild(el);

  let timer = 0;
  let on = false;
  let sticky = false; // awan adzan: bertahan sampai hideSticky()
  let placedView = "";

  // Posisi notch saat ini, ditentukan dari kelas dock. data-view bisa tertinggal "idle"/"clock" sesaat
  // setelah posisi dipulihkan (mis. saat aplikasi baru dibuka), jadi view idle ikut diterima; yang
  // ditolak hanya view kartu/hub karena awan akan menimpanya.
  const BUBBLE_VIEWS = new Set(["bottomIdle", "bottomMedia", "edgeIdle", "edgeMedia", "idle", "clock", "compact", "compactLyrics"]);
  const dockSide = (withRight = false): Side | null => {
    if (!BUBBLE_VIEWS.has(notch.dataset.view ?? "idle")) return null;
    if (notch.classList.contains("is-bottom")) return "bottom";
    if (notch.classList.contains("is-edge-left")) return "left";
    if ((BUBBLE_ON_RIGHT || withRight) && notch.classList.contains("is-edge-right")) return "right"; // withRight: awan adzan
    return null;
  };

  function hide(force = false) {
    if (sticky && !force) return;
    window.clearTimeout(timer);
    timer = 0;
    if (!on) return;
    on = false;
    el.classList.remove("show");
  }

  function show(text: string, sub: string, ms: number): boolean {
    if (sticky) return true; // awan adzan sedang tampil: pesan lain tidak menimpa
    const side = dockSide();
    if (!side) return false;

    textEl.textContent = text;
    subEl.textContent = sub;
    subEl.hidden = !sub;
    place(side);
    placedView = notch.dataset.view ?? "";

    if (!on) {
      on = true;
      el.classList.remove("show");
      void el.offsetWidth; // mulai ulang animasi muncul
      el.classList.add("show");
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, Math.max(1500, ms));
    return true;
  }

  function showSticky(text: string, sub: string): boolean {
    const side = dockSide(true);
    if (!side) return false;
    window.clearTimeout(timer);
    timer = 0;
    textEl.textContent = text;
    subEl.textContent = sub;
    subEl.hidden = !sub;
    sticky = true;
    place(side);
    placedView = notch.dataset.view ?? "";
    if (!on) {
      on = true;
      el.classList.remove("show");
      void el.offsetWidth;
      el.classList.add("show");
    }
    return true;
  }

  function hideSticky() {
    if (!sticky) return;
    sticky = false;
    hide(true);
  }

  // Posisikan awan terhadap notch. Dipanggil saat muncul dan saat bentuk notch berubah.
  function place(side: Side) {
    el.dataset.side = side;
    el.style.removeProperty("left");
    el.style.removeProperty("--tail-x");

    if (side === "bottom") {
      // Jaga awan tetap di dalam jendela (notch bisa berada dekat tepi kiri/kanan layar).
      const sr = shell.getBoundingClientRect();
      const bw = el.offsetWidth;
      const cx = sr.left + sr.width / 2;
      const pad = 8;
      const left = Math.min(Math.max(cx - bw / 2, pad), Math.max(pad, window.innerWidth - bw - pad));
      const tail = Math.min(Math.max(cx - left, 22), Math.max(22, bw - 22));
      el.style.left = `${Math.round(left - sr.left)}px`;
      el.style.setProperty("--tail-x", `${Math.round(tail)}px`);
    }
  }

  // Hover membuka hub, atau notch berpindah/berganti bentuk: awan harus hilang.
  notch.addEventListener("mouseenter", () => hide());
  new MutationObserver(() => {
    if (!on) return;
    const side = dockSide(sticky);
    if (!side) { sticky = false; hide(true); return; }
    // bentuk notch berganti (mis. idle -> bottomIdle): hitung ulang posisi awan
    const view = notch.dataset.view ?? "";
    if (view !== placedView) {
      placedView = view;
      place(side);
      // lebar notch beranimasi ~0.3 dtk; ukur ulang setelah selesai agar ekor awan tepat di tengah notch
      window.setTimeout(() => { const s = on ? dockSide(sticky) : null; if (s) place(s); }, 380);
    }
  })
    .observe(notch, { attributes: true, attributeFilter: ["data-view", "class"] });

  return { show, hide: () => hide(), showSticky, hideSticky, active: () => on };
}
