import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	use: {
		baseURL: process.env.GIRAFFE_E2E ?? "http://127.0.0.1:27045",
		browserName: "chromium",
	},
});
