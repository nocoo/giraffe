import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasApiRoutes } from "./has-api-routes";

describe("hasApiRoutes", () => {
	it("is false before any /api handler exists", async () => {
		expect(await hasApiRoutes()).toBe(false);
	});

	it("detects /api prefix imported from src/lib via @/", async () => {
		const root = await mkdtemp(join(tmpdir(), "giraffe-api-"));
		await mkdir(join(root, "src/lib"), { recursive: true });
		await mkdir(join(root, "src/server"), { recursive: true });
		await writeFile(join(root, "src/lib/api-root.ts"), 'export const API_ROOT = "/api";\n');
		await writeFile(
			join(root, "src/server/mount.ts"),
			'import { API_ROOT } from "@/lib/api-root";\napp.route(API_ROOT, r);\n',
		);
		expect(await hasApiRoutes(root)).toBe(true);
	});
});
