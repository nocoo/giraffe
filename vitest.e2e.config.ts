import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/api/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
	},
});
