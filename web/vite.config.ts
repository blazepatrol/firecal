import { defineConfig } from "vite";

// Relative base so the build works from any static host path (e.g. GitHub Pages /firecal/).
export default defineConfig({
  base: "./",
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", deck: "deck.html" } } },
});
