import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Self-host Excalidraw fonts (offline + Korean Xiaolai fallback).
const copyFonts = () => ({
	name: "copy-excalidraw-fonts",
	closeBundle() {
		const src = path.resolve("node_modules/@excalidraw/excalidraw/dist/prod/fonts");
		fs.cpSync(src, path.resolve("dist/fonts"), { recursive: true });
	},
});

export default defineConfig({
	plugins: [react(), copyFonts()],
	define: { "process.env.IS_PREACT": JSON.stringify("false") },
	build: { chunkSizeWarningLimit: 8000 },
});
