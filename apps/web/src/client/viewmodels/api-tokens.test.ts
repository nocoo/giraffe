import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import {
	createToken,
	listTokens,
	revokeToken,
	TOKEN_SCOPES,
	tokenScopesLabel,
	updateToken,
} from "./api-tokens";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiWrite: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("retains all external bot scopes and their labels", () => {
	expect(TOKEN_SCOPES).toEqual([
		"observations:read",
		"agent:read",
		"agent:write",
		"app:read",
		"app:write",
	]);
	expect(Object.keys(tokenScopesLabel)).toEqual([...TOKEN_SCOPES]);
	expect(Object.values(tokenScopesLabel).every(Boolean)).toBe(true);
});
it("sends account-bound token management only through the browser API adapter", async () => {
	const created = { id: "token/id", token: "giraffe_fixture" };
	vi.mocked(apiPost).mockResolvedValueOnce(created);
	await listTokens("a/b");
	expect(await createToken("a/b", "External bot", ["agent:read"], 90)).toBe(created);
	await updateToken("a/b", "token/id", "new", ["agent:read"]);
	await revokeToken("a/b", "token/id");
	expect(apiGet).toHaveBeenCalledExactlyOnceWith("tokens?account_id=a%2Fb");
	expect(apiPost).toHaveBeenCalledExactlyOnceWith("tokens", {
		account_id: "a/b",
		label: "External bot",
		scopes: ["agent:read"],
		expires_in_days: 90,
	});
	expect(apiWrite).toHaveBeenNthCalledWith(1, "tokens/token%2Fid", "PATCH", {
		account_id: "a/b",
		label: "new",
		scopes: ["agent:read"],
	});
	expect(apiWrite).toHaveBeenNthCalledWith(2, "tokens/token%2Fid", "DELETE", {
		account_id: "a/b",
	});
});
