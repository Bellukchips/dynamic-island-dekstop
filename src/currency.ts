// Currency page: IDR converter + month-to-date snapshot of selected IDX shares.
import { invoke } from "@tauri-apps/api/core";
// Data sources are public endpoints; unavailable data is shown as unavailable (never fabricated).
type RateResponse = { amount?: number; base?: string; date?: string; rates?: Record<string, number>; result?: string; time_last_update_utc?: string };
type StockPoint = { symbol: string; name: string; change: number; last: number };

const CURRENCIES: Record<string, { name: string; digits: number }> = {
  USD: { name: "Dolar AS", digits: 4 }, SGD: { name: "Dolar Singapura", digits: 4 }, EUR: { name: "Euro", digits: 4 },
  JPY: { name: "Yen Jepang", digits: 4 }, MYR: { name: "Ringgit Malaysia", digits: 4 }, CNY: { name: "Yuan Tiongkok", digits: 4 },
  GBP: { name: "Pound Inggris", digits: 4 }, AUD: { name: "Dolar Australia", digits: 4 }, SAR: { name: "Riyal Saudi", digits: 4 },
  KRW: { name: "Won Korea", digits: 4 }, THB: { name: "Baht Thailand", digits: 4 }, INR: { name: "Rupee India", digits: 4 },
  CHF: { name: "Franc Swiss", digits: 4 }, HKD: { name: "Dolar Hong Kong", digits: 4 }, CAD: { name: "Dolar Kanada", digits: 4 },
};

let activeCurrencyRefresh: (() => void) | null = null;

const IDX_WATCHLIST = [
  ["BBCA.JK", "BBCA"], ["BBRI.JK", "BBRI"], ["BMRI.JK", "BMRI"], ["BBNI.JK", "BBNI"],
  ["TLKM.JK", "TLKM"], ["ASII.JK", "ASII"], ["ANTM.JK", "ANTM"], ["GOTO.JK", "GOTO"],
  ["ICBP.JK", "ICBP"], ["MDKA.JK", "MDKA"], ["BRPT.JK", "BRPT"], ["INDF.JK", "INDF"],
] as const;

export function initCurrencyPage(): () => void {
  // Idempoten: index.html dan main.ts boleh memanggil initializer tanpa membuat listener ganda.
  if (activeCurrencyRefresh) return activeCurrencyRefresh;

  const amountEl = document.getElementById("cu-amount") as HTMLInputElement | null;
  const targetEl = document.getElementById("cu-target") as HTMLSelectElement | null;
  const resultEl = document.getElementById("cu-result");
  const rateEl = document.getElementById("cu-rate");
  const updatedEl = document.getElementById("cu-updated");
  const refreshEl = document.getElementById("cu-refresh");
  const gainersEl = document.getElementById("cu-gainers");
  const losersEl = document.getElementById("cu-losers");
  const stockStatusEl = document.getElementById("cu-stock-status");
  const stockPeriodEl = document.getElementById("cu-stock-period");
  const badgeEl = document.getElementById("cu-badge");
  const quickEl = document.querySelector<HTMLElement>(".cu-quick");
  if (!amountEl || !targetEl || !resultEl || !rateEl || !updatedEl || !refreshEl || !gainersEl || !losersEl || !stockStatusEl || !stockPeriodEl) {
    return () => {};
  }

  // Simpan elemen sebagai alias non-null setelah guard. TypeScript tidak selalu
  // mempertahankan narrowing variabel DOM yang ditangkap oleh fungsi nested.
  const amountInputEl = amountEl as HTMLInputElement;
  const targetSelectEl = targetEl as HTMLSelectElement;
  const resultElement = resultEl as HTMLElement;
  const rateElement = rateEl as HTMLElement;
  const updatedElement = updatedEl as HTMLElement;
  const refreshButton = refreshEl as HTMLElement;
  const gainersElement = gainersEl as HTMLElement;
  const losersElement = losersEl as HTMLElement;
  const stockStatusElement = stockStatusEl as HTMLElement;
  const stockPeriodElement = stockPeriodEl as HTMLElement;
  const MAX_DIGITS = 15;

  let rates: Record<string, number> | null = null;
  let ratesDate = "";
  let lastLoadedAt = 0;
  let loading: Promise<void> | null = null;
  let stockSnapshot: StockPoint[] | null = null;
  let stockLoadedAt = 0;

  const NO_DECIMALS = new Set(["IDR", "JPY", "KRW"]);
  const fmt = (value: number, currency: string) => new Intl.NumberFormat("id-ID", {
    style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: NO_DECIMALS.has(currency) ? 0 : 2,
  }).format(value);
  // Format Rupiah: 1234567 -> "1.234.567"
  const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fmtIdr = (value: number) => `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value)}`;
  const digitsOf = (raw: string) => raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, MAX_DIGITS);
  // Tempel angka bergaya Indonesia ("1.500.000,50") atau internasional ("1,500,000.50"): pecahan dibuang.
  const pastedDigits = (raw: string) => {
    let s = raw.replace(/rp\.?/i, "").replace(/\s/g, "");
    if (/[.,]\d{1,2}$/.test(s) && (s.match(/[.,]/g) || []).length >= 1) {
      const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
      const before = s.slice(0, last);
      const sepsBefore = (before.match(/[.,]/g) || []).length;
      const isDecimal = s[last] === "," ? true : (sepsBefore === 0 || /,/.test(before));
      if (isDecimal) s = before;
    }
    return digitsOf(s);
  };
  const prettyDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })
    : v;
  const currentAmount = () => Number(digitsOf(amountInputEl.value) || "0");
  const safeText = (el: Element, text: string) => { el.textContent = text; };

  function paintConversion() {
    const target = targetSelectEl.value || "USD";
    const amount = currentAmount();
    const rate = rates?.[target];
    const opt = targetSelectEl.selectedOptions[0];
    if (badgeEl) badgeEl.textContent = (opt?.textContent || target).split("·")[0].trim();
    quickEl?.querySelectorAll<HTMLButtonElement>("button[data-amt]").forEach(b => {
      b.classList.toggle("on", Number(b.dataset.amt) === amount);
    });
    if (!Number.isFinite(rate) || rate === undefined || rate <= 0) {
      safeText(resultElement, rates ? "Kurs tidak tersedia" : "Memuat kurs…");
      safeText(rateElement, "Periksa koneksi lalu tekan ↻");
      return;
    }
    safeText(resultElement, fmt(amount * rate, target));
    safeText(rateElement, `1 ${target} = ${fmtIdr(1 / rate)} · ${ratesDate || "kurs referensi"}`);
  }

  async function fetchJson(url: string): Promise<any> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { window.clearTimeout(timeout); }
  }

  async function loadRates(force = false) {
    if (!force && rates && Date.now() - lastLoadedAt < 5 * 60_000) { paintConversion(); return; }
    safeText(resultElement, "Memuat kurs…");
    safeText(rateElement, "Mengambil kurs referensi terbaru…");

    try {
      const rateUrls = [
        "https://open.er-api.com/v6/latest/IDR",
        "https://api.frankfurter.dev/v1/latest?base=IDR",
        "https://api.frankfurter.app/latest?from=IDR",
      ];
      const merged: Record<string, number> = {};
      let firstDate = "";
      let lastError: unknown;

      // Sumber pertama yang valid dipakai; sumber berikutnya hanya melengkapi kode mata uang
      // yang belum tersedia. Nilai yang tidak valid tidak pernah digunakan untuk konversi.
      for (const url of rateUrls) {
        const missingCodes = Object.keys(CURRENCIES).filter(code => !Number.isFinite(merged[code]) || merged[code] <= 0);
        if (missingCodes.length === 0) break;
        try {
          const candidate = await fetchJson(url) as RateResponse;
          const sourceRates = candidate?.rates;
          if (!sourceRates || typeof sourceRates !== "object") throw new Error("Format data kurs tidak valid");
          for (const code of Object.keys(CURRENCIES)) {
            const value = Number(sourceRates[code]);
            if (Number.isFinite(value) && value > 0 && !Number.isFinite(merged[code])) merged[code] = value;
          }
          if (!firstDate) {
            const rawDate = String(candidate.date || candidate.time_last_update_utc || "");
            const isoDate = rawDate.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
            const parsedDate = rawDate ? new Date(rawDate) : null;
            firstDate = isoDate || (parsedDate && Number.isFinite(parsedDate.getTime())
              ? parsedDate.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
              : "");
          }
        } catch (error) {
          lastError = error;
        }
      }

      if (!Object.keys(merged).length) throw lastError || new Error("Sumber kurs tidak tersedia");
      rates = merged;
      ratesDate = prettyDate(firstDate);
      lastLoadedAt = Date.now();
      paintConversion();
      safeText(updatedElement, `Kurs referensi ${ratesDate || "terbaru"}`);
    } catch (error) {
      console.warn("[Currency] Gagal memuat kurs:", error);
      if (rates) {
        // Pertahankan kurs valid terakhir jika pembaruan sementara gagal.
        paintConversion();
        safeText(updatedElement, `Kurs terakhir ${ratesDate || "tersimpan"} · pembaruan gagal`);
      } else {
        safeText(resultElement, "Kurs belum tersedia");
        safeText(rateElement, "Koneksi gagal · tekan ↻ untuk mencoba lagi");
        safeText(updatedElement, "Kurs tidak dapat dimuat");
      }
    }
  }

  async function fetchStock(symbol: string, label: string, period1: number, period2: number): Promise<StockPoint | null> {
    try {
      // Yahoo Finance tidak mengizinkan fetch browser dari origin localhost melalui CORS.
      // Request dijalankan oleh Rust (reqwest), lalu JSON dikembalikan ke WebView via Tauri invoke.
      const data = await invoke<any>("fetch_yahoo_chart", { symbol, period1, period2 });
      const result = data?.chart?.result?.[0];
      const timestamps: number[] = result?.timestamp || [];
      const rawCloses: unknown[] = result?.indicators?.quote?.[0]?.close || [];
      const points = rawCloses
        .map((value, index) => ({ time: Number(timestamps[index] ?? 0), close: value }))
        .filter((point): point is { time: number; close: number } =>
          Number.isFinite(point.time) && point.time > 0 && typeof point.close === "number" && Number.isFinite(point.close) && point.close > 0)
        .sort((a, b) => a.time - b.time);
      if (points.length < 2) return null;
      const first = points[0].close, last = points[points.length - 1].close;
      return { symbol, name: label, change: (last - first) / first * 100, last };
    } catch (error) {
      console.warn(`[Currency] Gagal memuat saham ${symbol} lewat backend:`, error);
      return null;
    }
  }

  function paintStockGroup(el: HTMLElement, items: StockPoint[], positive: boolean) {
    el.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "cu-muted";
      empty.textContent = "Data belum tersedia";
      el.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 3)) {
      const row = document.createElement("div");
      row.className = "cu-stock-row";
      const who = document.createElement("div"); who.className = "cu-stock-who";
      const name = document.createElement("b"); name.textContent = item.name;
      const price = document.createElement("em"); price.textContent = fmtIdr(item.last);
      who.append(name, price);
      const change = document.createElement("span");
      change.className = `cu-chg ${positive ? "cu-positive" : "cu-negative"}`;
      change.textContent = `${item.change > 0 ? "+" : ""}${item.change.toLocaleString("id-ID", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
      row.append(who, change); el.appendChild(row);
    }
  }

  async function loadStocks(force = false) {
    if (!force && stockSnapshot && Date.now() - stockLoadedAt < 10 * 60_000) { paintStocks(stockSnapshot); return; }
    safeText(gainersElement, "Memuat…"); safeText(losersElement, "Memuat…");
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const period1 = Math.floor(start.getTime() / 1000);
    const period2 = Math.floor((now.getTime() + 24 * 60 * 60 * 1000) / 1000);
    stockPeriodElement.textContent = `MTD · ${start.toLocaleDateString("id-ID", { day: "numeric", month: "short" })}`;
    const results = await Promise.allSettled(IDX_WATCHLIST.map(([symbol, label]) => fetchStock(symbol, label, period1, period2)));
    const points = results
      .filter((result): result is PromiseFulfilledResult<StockPoint | null> => result.status === "fulfilled")
      .map(result => result.value)
      .filter((point): point is StockPoint => point !== null)
      .sort((a, b) => b.change - a.change);
    stockLoadedAt = Date.now();
    if (points.length < 2) {
      stockSnapshot = null;
      paintStockGroup(gainersElement, [], true); paintStockGroup(losersElement, [], false);
      safeText(stockStatusElement, "Data saham belum tersedia. Periksa koneksi atau akses sumber data.");
      return;
    }
    stockSnapshot = points;
    paintStocks(points);
  }

  function paintStocks(points: StockPoint[]) {
    paintStockGroup(gainersElement, points.filter(x => x.change > 0).slice(0, 3), true);
    paintStockGroup(losersElement, [...points].filter(x => x.change < 0).sort((a, b) => a.change - b.change).slice(0, 3), false);
    const month = new Date().toLocaleDateString("id-ID", { month: "long", year: "numeric" });
    safeText(stockStatusElement, `Pilihan saham IDX · ${month} · data Yahoo Finance; bukan seluruh bursa.`);
  }

  function refresh(force = false) {
    if (loading) return loading;
    loading = Promise.all([loadRates(force), loadStocks(force)]).then(() => {
      if (updatedElement.textContent?.startsWith("Kurs referensi")) {
        safeText(updatedElement, `Diperbarui ${new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`);
      }
    }).finally(() => { loading = null; });
    return loading;
  }

  // Input Rupiah: hanya angka, otomatis berpemisah titik ("1234567" -> "1.234.567"), posisi kursor dijaga.
  const setAmount = (digits: string) => { amountInputEl.value = groupDigits(digits); paintConversion(); };
  amountInputEl.addEventListener("input", () => {
    const raw = amountInputEl.value;
    const caret = amountInputEl.selectionStart ?? raw.length;
    const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, "").length;
    const digits = digitsOf(raw);
    const formatted = groupDigits(digits);
    amountInputEl.value = formatted;
    let seen = 0, pos = 0;
    while (pos < formatted.length && seen < Math.min(digitsBeforeCaret, digits.length)) { if (/\d/.test(formatted[pos])) seen++; pos++; }
    amountInputEl.setSelectionRange(pos, pos);
    paintConversion();
  });
  amountInputEl.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text") ?? "";
    setAmount(pastedDigits(text));
  });
  amountInputEl.addEventListener("focus", () => amountInputEl.select());
  amountInputEl.addEventListener("blur", () => { if (!digitsOf(amountInputEl.value)) setAmount("0"); });
  quickEl?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-amt]");
    if (!btn) return;
    event.preventDefault(); event.stopPropagation();
    setAmount(String(btn.dataset.amt || "0"));
  });
  amountInputEl.value = groupDigits(digitsOf(amountInputEl.value) || "0");
  targetSelectEl.addEventListener("change", paintConversion);
  refreshButton.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void refresh(true); });
  activeCurrencyRefresh = () => { void refresh(); };
  void refresh();
  return activeCurrencyRefresh;
}
