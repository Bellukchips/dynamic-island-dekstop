// @ts-nocheck
// Pembukaan kalender.

export function register(ctx: Record<string, any>): void {
    ctx.openCalendar = function openCalendar() {
        ctx.goToday(); // selalu mulai dari bulan ini
        ctx.hubByHover = true;
        ctx.closeAt = 0;
        ctx.expand("cal", 0);
    };
}

export function init(ctx: Record<string, any>): void {
    if (ctx.clockOn) {
        ctx.initCalendar();
        document
            .querySelector<HTMLElement>(".p-clock .ck-date")
            ?.addEventListener("click", (e) => { e.stopPropagation(); ctx.openCalendar(); });
        ctx.$("cal-back").addEventListener("click", (e) => { e.stopPropagation(); ctx.openHub(ctx.pageOf("clock")); });
    }
    else {
        document.querySelector(".l-cal")?.remove(); // tanpa halaman jam tidak ada jalan masuk ke kalender
    }
}
