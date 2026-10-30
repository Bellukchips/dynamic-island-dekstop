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

// Awan percakapan aktif untuk dock kiri, kanan, dan bawah.
const BUBBLE_ON_RIGHT = true;

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
    // Kelas dock adalah sumber posisi yang otoritatif. Baca dari notch DAN shell
    // karena keduanya disinkronkan saat drag/snap, tetapi dapat berbeda sesaat
    // ketika posisi dipulihkan dari konfigurasi.
    const isBottom = notch.classList.contains("is-bottom") || shell.classList.contains("is-bottom");
    const isLeft = notch.classList.contains("is-edge-left") || shell.classList.contains("is-edge-left");
    const isRight = notch.classList.contains("is-edge-right") || shell.classList.contains("is-edge-right");

    // Jangan tampilkan awan di atas hub/kartu interaktif. Namun kelas dock tetap
    // diperiksa lebih dahulu agar perubahan data-view yang terlambat tidak
    // membuat pesan jatuh ke kartu dev lama.
    const view = notch.dataset.view ?? "idle";
    if (isBottom && BUBBLE_VIEWS.has(view)) return "bottom";
    if (isLeft && BUBBLE_VIEWS.has(view)) return "left";
    if ((BUBBLE_ON_RIGHT || withRight) && isRight && BUBBLE_VIEWS.has(view)) return "right";
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

    // Selalu ukur terhadap posisi notch yang sebenarnya, bukan tepi #shell.
    // #shell adalah jendela native yang jauh lebih besar daripada notch; memakai
    // left:100% / bottom:100% dari shell membuat awan melompat jauh atau terpotong
    // ketika notch ditempelkan di sisi/bawah layar.
    const sr = shell.getBoundingClientRect();
    const nr = notch.getBoundingClientRect();
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    const gap = 10;
    const pad = 8;

    let left = nr.left - sr.left + (nr.width - bw) / 2;
    let top = nr.top - sr.top - bh - gap;

    if (side === "left") {
      // Awan berada di sebelah kanan notch yang menempel di sisi kiri.
      left = nr.right - sr.left + gap;
      top = nr.top - sr.top + (nr.height - bh) / 2;
    } else if (side === "right") {
      // Awan berada di sebelah kiri notch yang menempel di sisi kanan.
      left = nr.left - sr.left - bw - gap;
      top = nr.top - sr.top + (nr.height - bh) / 2;
    }

    // Jaga seluruh awan di dalam viewport. Koordinat kemudian dikonversi
    // kembali ke sistem koordinat #shell untuk positioning absolute.
    const minLeft = pad - sr.left;
    const maxLeft = window.innerWidth - bw - pad - sr.left;
    const minTop = pad - sr.top;
    const maxTop = window.innerHeight - bh - pad - sr.top;
    left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft));
    top = Math.min(Math.max(top, minTop), Math.max(minTop, maxTop));

    // Override aturan posisi CSS lama yang berbasis tepi shell.
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.translate = "none";
    el.style.removeProperty("--tail-x");

    if (side === "bottom") {
      const notchCenter = nr.left - sr.left + nr.width / 2;
      const tail = Math.min(Math.max(notchCenter - left, 22), Math.max(22, bw - 22));
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
