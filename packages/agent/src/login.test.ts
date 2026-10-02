import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	login: vi.fn(),
	browser: vi.fn(),
	directory: "",
}));
vi.mock("@nocoo/base-cli", () => ({
	performLogin: mocked.login,
	openBrowser: mocked.browser,
}));
vi.mock("./config.ts", async (original) => ({
	...(await original<typeof import("./config.ts")>()),
	homeDirectory: () => mocked.directory,
}));

import { login } from "./login.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	if (mocked.directory) rmSync(mocked.directory, { recursive: true, force: true });
	mocked.directory = "";
});
it("uses the platform browser, global fetch, and private user directory defaults", async () => {
	mocked.directory = mkdtempSync(join(tmpdir(), "giraffe-login-"));
	mocked.login.mockImplementation(async (deps: import("@nocoo/base-cli").LoginDeps) => {
		await deps.openBrowser(
			"https://example.test/authorize?callback=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback&state=test",
		);
		deps.onSaveToken("code");
		return { success: true };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				token: "fake",
				account_id: "test",
				expires_at: "2099-01-01T00:00:00Z",
				scopes: [],
			}),
		),
	);
	const log = vi.fn();
	expect((await login("https://example.test", { log })).accountId).toBe("test");
	expect(mocked.browser).toHaveBeenCalledOnce();
	expect(log).toHaveBeenCalledOnce();
	expect(mocked.login.mock.calls[0]?.[0].timeoutMs).toBe(180000);
});
it("rejects a nominally successful callback without an authorization code", async () => {
	mocked.login.mockImplementation(async (deps: import("@nocoo/base-cli").LoginDeps) => {
		await deps.openBrowser("https://example.test/authorize?state=test");
		return { success: true };
	});
	await expect(login("https://example.test")).rejects.toThrow(/not completed/);
});
