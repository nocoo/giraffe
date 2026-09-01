import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hasApiRoutes } from "./has-api-routes";

describe("hasApiRoutes", () => {
	it("is false before any /api handler exists", async () => {
		expect(await hasApiRoutes()).toBe(false);
	});

	it("detects /api prefix imported from src/lib", async () => {
		await mkdir("src/lib", { recursive: true });
		await writeFile("src/lib/api-root.ts", 'export const API_ROOT = "/api";\n');
		await mkdir("src/server", { recursive: true });
		await writeFile(
			"src/server/tmp-api-mount.ts",
			'import { API_ROOT } from "../lib/api-root";\napp.route(API_ROOT, r);\n',
		);
		try {
			expect(await hasApiRoutes()).toBe(true);
		} finally {
			await rm("src/lib/api-root.ts");
			await rm("src/server/tmp-api-mount.ts");
		}
	});
});
