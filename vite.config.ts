import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { localEnvironmentPlugin } from "./scripts/local-environment-plugin";

export default defineConfig({
	root: "apps/web",
	plugins: [react(), tailwindcss(), localEnvironmentPlugin()],
	build: {
		outDir: "../../dist/client",
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
	},
});
