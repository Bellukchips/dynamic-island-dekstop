// @ts-nocheck
// Pengingat, audio alarm, dan date picker.
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

export function register(ctx: Record<string, any>): void {
  ctx.beep = function beep() {
      try {
          ctx.audioCtx ??= new AudioContext();
          const ctx = ctx.audioCtx;
          if (ctx.state === "suspended")
              void ctx.resume();
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
      }
      catch { /* audio tidak tersedia: kartu tetap tampil */ }
  };
  ctx.showRing = function showRing() {
      const list = [...ctx.ringing.values()];
      if (list.length === 0) {
          if (ctx.override === "rem")
              ctx.collapse();
          return;
      }
      const r = list[0];
      ctx.$("rem-text").textContent = r.text;
      ctx.$("rem-sub").textContent =
          list.length > 1
              ? `Pengingat · +${list.length - 1} lagi`
              : `Pengingat${r.due_at ? " · " + ctx.fmtDue(r.due_at) : ""}`;
      ctx.hubByHover = false;
      ctx.expand("rem", 0); // tanpa timer: tidak hilang sendiri
  };
  ctx.endRing = function endRing(action: "stop" | "snooze") {
      const r = [...ctx.ringing.values()][0];
      if (!r)
          return;
      ctx.ringing.delete(r.id);
      const call = action === "stop"
          ? ctx.invoke<Reminder[]>("reminders_stop", { id: r.id })
          : ctx.invoke<Reminder[]>("reminders_snooze", { id: r.id, minutes: 5 });
      call.then(ctx.paintReminders).catch(() => { });
      ctx.flash(action === "stop" ? "happy" : "sleepy", 1200);
      ctx.showRing(); // tampilkan pengingat berikutnya, atau tutup kalau sudah habis
  };
  ctx.paintReminders = function paintReminders(items: Reminder[]) {
      // sinkronkan kartu: pengingat yang diselesaikan/dihapus/ditunda dari menu ikut hilang
      let changed = false;
      for (const id of [...ctx.ringing.keys()]) {
          const it = items.find((r) => r.id === id);
          if (!it || it.done || it.due_at > Date.now()) {
              ctx.ringing.delete(id);
              changed = true;
          }
      }
      if (changed)
          ctx.showRing();
      const list = document.getElementById("rm-list");
      if (!list)
          return; // halaman reminder dimatikan di config
      const left = items.filter((r) => !r.done).length;
      ctx.$("rm-count").textContent = left ? String(left) : "";
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
              due.textContent = `${ctx.fmtDue(r.due_at)}${repeatLabel}`;
              row.appendChild(due);
          }
          const x = document.createElement("span");
          x.className = "x";
          x.textContent = "×";
          row.appendChild(x);
          row.addEventListener("click", (e) => {
              e.stopPropagation();
              if ((e.target as HTMLElement).closest(".x")) {
                  ctx.invoke<Reminder[]>("reminders_remove", { id: r.id }).then(ctx.paintReminders).catch(() => { });
              }
              else {
                  ctx.invoke<Reminder[]>("reminders_toggle", { id: r.id }).then(ctx.paintReminders).catch(() => { });
                  if (!r.done)
                      ctx.flash("happy", 900);
              }
          });
          list.appendChild(row);
      });
  };
  ctx.refreshReminders = function refreshReminders() {
      ctx.invoke<Reminder[]>("reminders_list").then(ctx.paintReminders).catch(() => { });
  };
  ctx.paintWhen = function paintWhen() {
      ctx.$("rm-when-txt").textContent = ctx.pickAt ? ctx.fmtDue(ctx.pickAt) : "";
      ctx.$("rm-when").classList.toggle("set", ctx.pickAt !== 0);
  };
  ctx.paintRepeatMode = function paintRepeatMode() {
      const select = document.getElementById("pk-repeat-mode") as HTMLSelectElement | null;
      if (select)
          select.value = ctx.repeatMode;
  };
  ctx.formatDmy = function formatDmy(date: Date): string {
      const dd = String(date.getDate()).padStart(2, "0");
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const yyyy = String(date.getFullYear()).padStart(4, "0");
      return `${dd}/${mm}/${yyyy}`;
  };
  ctx.formatDmyInput = function formatDmyInput(value: string): string {
      const digits = value.replace(/\D/g, "").slice(0, 8);
      if (digits.length < 2)
          return digits;
      if (digits.length === 2)
          return `${digits}/`;
      if (digits.length < 4)
          return `${digits.slice(0, 2)}/${digits.slice(2)}`;
      if (digits.length === 4)
          return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/`;
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  };
  ctx.parseDmy = function parseDmy(value: string): {
      year: number;
      month: number;
      day: number;
  } | null {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
      if (!match)
          return null;
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]);
      if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31)
          return null;
      const check = new Date(year, month - 1, day);
      if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day)
          return null;
      return { year, month, day };
  };
  ctx.setPkDateFromInput = function setPkDateFromInput(): boolean {
      if (!ctx.pkDateInput)
          return false;
      const parsed = ctx.parseDmy(ctx.pkDateInput.value);
      if (!parsed)
          return false;
      // Konstruksi ulang tanggal agar tanggal 31 tidak overflow saat berpindah bulan.
      ctx.pk = new Date(parsed.year, parsed.month - 1, parsed.day, ctx.pk.getHours(), ctx.pk.getMinutes(), 0, 0);
      return true;
  };
  ctx.paintPick = function paintPick() {
      ctx.$("pk-h").textContent = String(ctx.pk.getHours()).padStart(2, "0");
      ctx.$("pk-m").textContent = String(ctx.pk.getMinutes()).padStart(2, "0");
  };
  ctx.syncHubDynamicHeight = function syncHubDynamicHeight() {
      const reminderExpanded = ctx.notch.classList.contains("reminder-picking");
      const notesExpanded = ctx.notch.classList.contains("notes-expanded");
      const currencyExpanded = ctx.names[ctx.page] === "currency";
      const ramadanExpanded = ctx.names[ctx.page] === "prayer" && ctx.notch.classList.contains("ramadan-expanded");
      const width = (currencyExpanded || ramadanExpanded) ? 780 : ctx.BASE_SIZES.hub[0];
      const height = ramadanExpanded ? 540 : reminderExpanded ? 230 : notesExpanded ? 300 : currencyExpanded ? 520 : ctx.BASE_SIZES.hub[1];
      const hitWidth = (currencyExpanded || ramadanExpanded) ? 770 : ctx.BASE_HIT.hub[0];
      const hitHeight = ramadanExpanded ? 580 : reminderExpanded ? 242 : notesExpanded ? 330 : currencyExpanded ? 560 : ctx.BASE_HIT.hub[1];
      ctx.SIZES.hub[0] = Math.round(width * ctx.CFG.scale);
      ctx.SIZES.hub[1] = Math.round(height * ctx.CFG.scale);
      ctx.HIT.hub[0] = Math.round(hitWidth * ctx.CFG.scale);
      ctx.HIT.hub[1] = Math.round(hitHeight * ctx.CFG.scale);
      // Variabel CSS ditempatkan langsung pada notch supaya track, page, dan nav ikut melebar.
      ctx.notch.classList.toggle("currency-expanded", currencyExpanded || ramadanExpanded);
      ctx.notch.style.setProperty("--hub-w", `${width}px`);
      ctx.notch.style.setProperty("--hub-h", `${height}px`);
      if (ctx.notch.dataset.view === "hub") {
          void ctx.syncNativeWindowSize("hub").then(() => {
              if (ctx.notch.dataset.view !== "hub")
                  return;
              ctx.placeShell("hub");
              ctx.setHit("hub");
          }).catch((error) => console.error("Gagal mengubah ukuran panel Currency:", error));
      }
  };
  ctx.setReminderPickerExpanded = function setReminderPickerExpanded(expanded: boolean) {
      ctx.notch.classList.toggle("reminder-picking", expanded);
      ctx.syncHubDynamicHeight();
  };
  ctx.openPick = function openPick() {
      if (ctx.pickAt) {
          ctx.pk = new Date(ctx.pickAt);
          if (ctx.pkDateInput)
              ctx.pkDateInput.value = ctx.formatDmy(ctx.pk);
      }
      else {
          // Tanggal default selalu hari ini; waktu awal dibulatkan ke kelipatan 5 menit berikutnya.
          const today = new Date();
          if (ctx.pkDateInput)
              ctx.pkDateInput.value = ctx.formatDmy(today);
          ctx.pk = new Date(today);
          ctx.pk.setMinutes(Math.ceil(ctx.pk.getMinutes() / 5) * 5, 0, 0);
      }
      ctx.pkDateInput?.classList.remove("invalid");
      ctx.pkDateInput?.removeAttribute("aria-invalid");
      ctx.paintPick();
      ctx.paintRepeatMode();
      ctx.remPage?.classList.add("picking");
      ctx.setReminderPickerExpanded(true);
  };
  ctx.addReminder = function addReminder() {
      const input = ctx.$("rm-input") as HTMLInputElement;
      const text = input.value.trim();
      if (!text)
          return;
      const mode: RepeatMode = ctx.pickAt > 0 ? ctx.repeatMode : "none";
      const timezoneOffsetMinutes = ctx.pickAt > 0 ? new Date(ctx.pickAt).getTimezoneOffset() : new Date().getTimezoneOffset();
      ctx.invoke<Reminder[]>("reminders_add", {
          text,
          dueAt: ctx.pickAt,
          repeatMode: mode,
          timezoneOffsetMinutes,
      })
          .then((items) => {
          ctx.paintReminders(items);
          input.value = "";
          ctx.pickAt = 0;
          ctx.repeatMode = "none";
          ctx.paintWhen();
          ctx.paintRepeatMode();
          ctx.closePick();
          ctx.flash("happy", 900);
      })
          .catch(() => { });
  };
}

export function init(ctx: Record<string, any>): void {
  ctx.fmtDue = (ms: number) => {
      if (!ms)
          return "";
      const d = new Date(ms);
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return d.toLocaleString("id-ID", {
          day: "numeric", month: "short",
          year: sameYear ? undefined : "numeric",
          hour: "2-digit", minute: "2-digit",
      });
  };
  ctx.ringing = new Map<string, Reminder>();
  ctx.audioCtx = null;
  document.getElementById("rem-stop")?.addEventListener("click", (e) => { e.stopPropagation(); ctx.endRing("stop"); });
  document.getElementById("rem-snooze")?.addEventListener("click", (e) => { e.stopPropagation(); ctx.endRing("snooze"); });
  document.getElementById("rm-clear-done")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.invoke<Reminder[]>("reminders_clear_done").then(ctx.paintReminders).catch(() => { });
  });
  ctx.remPage = document.querySelector<HTMLElement>(".p-reminder");
  ctx.pickAt = 0;
  ctx.pk = new Date();
  ctx.repeatMode = "none";
  ctx.pkDateInput = document.getElementById("pk-date-input") as HTMLInputElement | null;
  ctx.closePick = () => {
      ctx.remPage?.classList.remove("picking");
      ctx.setReminderPickerExpanded(false);
  };
  document.getElementById("rm-when")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ctx.remPage?.classList.contains("picking"))
          ctx.closePick();
      else
          ctx.openPick();
  });
  document.querySelectorAll<HTMLElement>("[data-pk]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const [unit, sign] = [b.dataset.pk![0], b.dataset.pk![1] === "+" ? 1 : -1];
      if (unit === "h")
          ctx.pk.setHours(ctx.pk.getHours() + sign);
      else if (unit === "m")
          ctx.pk.setMinutes(ctx.pk.getMinutes() + sign * 5);
      ctx.paintPick();
  }));
  // Sisipkan garis miring otomatis setelah DD dan MM, sambil menjaga posisi caret.
  ctx.pkDateInput?.addEventListener("input", () => {
      const oldValue = ctx.pkDateInput.value;
      const oldCaret = ctx.pkDateInput.selectionStart ?? oldValue.length;
      const digitsBeforeCaret = oldValue.slice(0, oldCaret).replace(/\D/g, "").length;
      const formatted = ctx.formatDmyInput(oldValue);
      ctx.pkDateInput.value = formatted;
      let nextCaret = digitsBeforeCaret;
      if (digitsBeforeCaret === 2 && formatted.length >= 3)
          nextCaret = 3;
      else if (digitsBeforeCaret === 4 && formatted.length >= 6)
          nextCaret = 6;
      else if (digitsBeforeCaret > 2 && digitsBeforeCaret < 4)
          nextCaret = digitsBeforeCaret + 1;
      else if (digitsBeforeCaret > 4)
          nextCaret = digitsBeforeCaret + 2;
      nextCaret = Math.min(nextCaret, formatted.length);
      ctx.pkDateInput.setSelectionRange(nextCaret, nextCaret);
      ctx.pkDateInput.classList.remove("invalid");
      ctx.pkDateInput.removeAttribute("aria-invalid");
      const parsed = ctx.parseDmy(formatted);
      if (parsed) {
          ctx.pk = new Date(parsed.year, parsed.month - 1, parsed.day, ctx.pk.getHours(), ctx.pk.getMinutes(), 0, 0);
      }
  });
  ctx.pkDateInput?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // Backspace tepat setelah slash menghapus digit di depannya, bukan slash otomatis.
      if (e.key === "Backspace" && ctx.pkDateInput.selectionStart === ctx.pkDateInput.selectionEnd) {
          const caret = ctx.pkDateInput.selectionStart ?? 0;
          if (caret > 0 && ctx.pkDateInput.value[caret - 1] === "/") {
              e.preventDefault();
              const digits = ctx.pkDateInput.value.replace(/\D/g, "");
              const digitsBefore = ctx.pkDateInput.value.slice(0, caret - 1).replace(/\D/g, "").length;
              const removeAt = Math.max(0, digitsBefore - 1);
              const nextDigits = digits.slice(0, removeAt) + digits.slice(removeAt + 1);
              ctx.pkDateInput.value = ctx.formatDmyInput(nextDigits);
              const nextCaret = Math.min(removeAt, ctx.pkDateInput.value.length);
              ctx.pkDateInput.setSelectionRange(nextCaret, nextCaret);
              ctx.pkDateInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
      }
  });
  document.getElementById("pk-repeat-mode")?.addEventListener("change", (e) => {
      e.stopPropagation();
      const value = (e.currentTarget as HTMLSelectElement).value;
      ctx.repeatMode = value === "daily" || value === "monthly" ? value : "none";
  });
  document.getElementById("pk-ok")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!ctx.setPkDateFromInput()) {
          ctx.pkDateInput?.classList.add("invalid");
          ctx.pkDateInput?.setAttribute("aria-invalid", "true");
          ctx.pkDateInput?.focus();
          return;
      }
      ctx.pk.setSeconds(0, 0);
      ctx.pickAt = ctx.pk.getTime();
      ctx.pkDateInput?.classList.remove("invalid");
      ctx.pkDateInput?.removeAttribute("aria-invalid");
      ctx.paintWhen();
      // Jika teks pengingat sudah diisi, tombol Atur sekaligus menyimpan item ke daftar.
      // Jika input masih kosong, simpan pilihan tanggal/jam sementara dan tutup picker;
      // item bisa dibuat setelah teks diisi dengan tombol tambah.
      const reminderText = (document.getElementById("rm-input") as HTMLInputElement | null)?.value.trim();
      if (reminderText) {
          ctx.addReminder();
          return;
      }
      ctx.closePick();
  });
  document.getElementById("pk-clear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.pickAt = 0;
      ctx.pkDateInput?.classList.remove("invalid");
      ctx.pkDateInput?.removeAttribute("aria-invalid");
      ctx.repeatMode = "none";
      ctx.paintWhen();
      ctx.paintRepeatMode();
      ctx.closePick();
  });
  document.getElementById("rm-add-btn")?.addEventListener("click", (e) => { e.stopPropagation(); ctx.addReminder(); });
  document.getElementById("rm-input")?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === "Enter")
          ctx.addReminder();
  });
  ctx.paintWhen();
  ctx.paintRepeatMode();
  // dikirim Rust saat jatuh tempo, lalu diulang tiap 20 detik sampai dihentikan
  ctx.listen<Reminder>("reminder-due", (e) => {
      const r = e.payload;
      const first = !ctx.ringing.has(r.id);
      ctx.ringing.set(r.id, r);
      ctx.beep();
      if (first || ctx.override === null) {
          ctx.flash("surprised", 2500);
          ctx.showRing();
      }
      else {
          ctx.flash("surprised", 1200);
      }
      ctx.refreshReminders();
  });
  ctx.refreshReminders();
}
