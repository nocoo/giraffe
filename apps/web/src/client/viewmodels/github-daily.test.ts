// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { dailyReport } from "../../../../../tests/fixtures/daily-report";
import { loadGithubDaily } from "./github-daily";
import { setActiveAccountId } from "./session";

afterEach(() => {
	setActiveAccountId(null);
	vi.unstubAllGlobals();
});

it("R8 daily reads are account-fenced and invalid stored payloads become a notice rather than content", async () => {
	const calls: string[] = [];
	const valid = dailyReport();
	const bad = { ...valid, payload: { ...valid.payload, links: { xray: "javascript:alert(1)" } } };
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return Response.json(
			String(input) === "/api/accounts"
				? { accounts: [{ id: "a", is_active: true }] }
				: { account_id: "a", items: [bad, valid], invalidCount: 2 },
		);
	});
	expect(await loadGithubDaily()).toEqual({ account_id: "a", items: [valid], invalidCount: 3 });
	expect(calls).toEqual(["/api/accounts", "/api/agent/accounts/a/analysis/daily"]);
});

it("R8 daily refuses changed accounts and malformed response envelopes", async () => {
	for (const response of [
		{ account_id: "other", items: [], invalidCount: 0 },
		{ account_id: "a", items: [], invalidCount: -1 },
		{ account_id: "a", items: null, invalidCount: 0 },
	]) {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
			Response.json(
				String(input) === "/api/accounts" ? { accounts: [{ id: "a", is_active: true }] } : response,
			),
		);
		await expect(loadGithubDaily()).rejects.toThrow();
	}
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		if (String(input) === "/api/accounts")
			return Response.json({ accounts: [{ id: "a", is_active: true }] });
		setActiveAccountId("other");
		return Response.json({ account_id: "a", items: [], invalidCount: 0 });
	});
	await expect(loadGithubDaily()).rejects.toThrow("Account changed");
});
