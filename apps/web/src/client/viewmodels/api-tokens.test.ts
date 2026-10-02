import { beforeEach, expect, it, vi } from "vitest";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import {
	authorizeAgent,
	createToken,
	listTokens,
	loginRequest,
	revokeToken,
	updateToken,
} from "./api-tokens";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiWrite: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("validates browser login requests without permissive callback normalization", () => {
	const params = new URLSearchParams({
		redirect_uri: "http://127.0.0.1:12345/callback",
		state: "s",
		code_challenge: "a".repeat(43),
		code_challenge_method: "S256",
	});
	expect(loginRequest(params.toString())?.scopes).toHaveLength(3);
	for (const [key, value] of [
		["redirect_uri", "https://127.0.0.1:1/callback"],
		["redirect_uri", "http://localhost:0/callback"],
		["redirect_uri", "http://localhost:65536/callback"],
		["state", ""],
		["state", "\n"],
		["state", "a".repeat(513)],
		["code_challenge", "bad"],
		["code_challenge_method", "plain"],
		["scopes", "admin"],
		["scopes", ""],
	] as const) {
		const p = new URLSearchParams(params);
		p.set(key, value);
		expect(loginRequest(p.toString())).toBeNull();
	}
	expect(loginRequest("")).toBeNull();
	params.set("redirect_uri", "http://localhost:80/callback");
	params.set("scopes", "agent:read,agent:write");
	expect(loginRequest(params.toString())).not.toBeNull();
});
it("sends account-bound management calls only through the browser API adapter", async () => {
	await listTokens("a");
	await createToken("a", "CLI", ["agent:read"], 30);
	await updateToken("a", "id", "new", ["agent:read"]);
	await revokeToken("a", "id");
	const request = {
		redirect_uri: "http://localhost:1234/callback",
		state: "s",
		code_challenge: "a".repeat(43),
		code_challenge_method: "S256" as const,
		scopes: ["agent:read"],
	};
	await authorizeAgent(request, "a", "CLI");
	expect(apiGet).toHaveBeenCalledWith("tokens?account_id=a");
	expect(apiWrite).toHaveBeenCalledWith("tokens/id", "DELETE", { account_id: "a" });
	expect(apiPost).toHaveBeenLastCalledWith("cli/authorize", {
		...request,
		account_id: "a",
		label: "CLI",
		expires_in_days: 30,
		consent: true,
	});
});
