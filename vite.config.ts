import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
	},
	server: {
		port: 7045,
		strictPort: true,
		allowedHosts: ["giraffe.dev.hexly.ai"],
		hmr: {
			host: "giraffe.dev.hexly.ai",
			protocol: "wss",
			clientPort: 443,
		},
		proxy: {
			"/api": {
				target: "http://127.0.0.1:7046",
				changeOrigin: true,
			},
		},
	},
});
