import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Opsi Vite untuk pengembangan Tauri, hanya berlaku di `tauri dev` atau `tauri build`
  //
  // 1. jangan sembunyikan error dari Rust
  clearScreen: false,
  // 2. Tauri butuh port tetap, gagal kalau port itu sedang dipakai
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. abaikan `src-tauri` saat memantau perubahan file
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      // path relatif terhadap root proyek, jadi tidak perlu `path` maupun `__dirname`
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
}));