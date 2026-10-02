import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./vitest.setup.ts"],
		include: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx", "scripts/**/*.test.ts"],
		exclude: ["node_modules/**"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json"],
			include: ["apps/web/src/**/*.{ts,tsx}"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/__tests__/**",
				"apps/web/src/client/routes/**/*.tsx",
				"apps/web/src/client/components/layout/**/*.tsx",
				"apps/web/src/client/main.tsx",
				"apps/web/src/client/app.tsx",
			],
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
