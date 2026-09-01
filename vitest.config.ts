import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./vitest.setup.ts"],
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		exclude: ["node_modules/**"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "src/client/routes/**/*.tsx"],
			thresholds: {
				statements: 95,
				branches: 95,
				functions: 95,
				lines: 95,
			},
		},
	},
	resolve: {
		alias: {
			"@": resolve(root, "./src"),
		},
	},
});
