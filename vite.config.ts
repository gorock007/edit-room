import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = `http://127.0.0.1:${process.env.ROOM_PORT ?? 4310}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5310,
    proxy: {
      "/api": api,
      "/media": api,
      "/overlay": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
