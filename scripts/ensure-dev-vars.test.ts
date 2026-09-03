import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDevVars } from "./ensure-dev-vars";

async function withDir(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "giraffe-dev-vars-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("ensureDevVars", () => {
	it("writes development bypass vars when missing", async () => {
		await withDir(async (root) => {
			await writeFile(
				join(root, "dev.vars.example"),
				[
					"ENVIRONMENT=development",
					"GITHUB_API_BASE=https://api.github.com",
					"TOKEN_ENCRYPTION_KEY_CURRENT=1",
					"TOKEN_ENCRYPTION_KEY_V1=",
					"",
				].join("\n"),
			);
			ensureDevVars(root);
			const body = await readFile(join(root, ".dev.vars"), "utf8");
			expect(body).toContain("ENVIRONMENT=development");
			expect(body).toContain("GITHUB_API_BASE=https://api.github.com");
			expect(body).not.toContain("CF_ACCESS_TEAM_DOMAIN");
			expect(body).not.toContain("CF_ACCESS_AUD");
			expect(body).toMatch(/TOKEN_ENCRYPTION_KEY_V1=[0-9a-f]{64}\n/);
		});
	});

	it("restores a leftover typecheck file before generating", async () => {
		await withDir(async (root) => {
			await writeFile(join(root, ".dev.vars.__typecheck"), "ENVIRONMENT=development\nKEPT=1\n");
			ensureDevVars(root);
			expect(await readFile(join(root, ".dev.vars"), "utf8")).toBe(
				"ENVIRONMENT=development\nKEPT=1\n",
			);
		});
	});

	it("does not overwrite an existing file", async () => {
		await withDir(async (root) => {
			await writeFile(join(root, ".dev.vars"), "ENVIRONMENT=development\n");
			ensureDevVars(root);
			expect(await readFile(join(root, ".dev.vars"), "utf8")).toBe("ENVIRONMENT=development\n");
		});
	});
});
