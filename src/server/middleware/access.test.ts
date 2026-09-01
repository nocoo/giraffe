import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { ACCESS_TEAM_DOMAIN } from "../lib/access-config";
import { ApiError } from "../lib/errors";
import { accessBypass, resolveIdentity } from "./access";

function env(partial: Partial<Env>): Env {
	return {
		DB: {} as D1Database,
		ASSETS: { fetch: () => Promise.reject(new Error("no")) } as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		...partial,
	};
}

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(
	key: CryptoKey,
	payload: Record<string, unknown>,
	kid = "k1",
): Promise<string> {
	const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
	const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = new Uint8Array(
		await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			key,
			new TextEncoder().encode(`${header}.${body}`),
		),
	);
	return `${header}.${body}.${b64url(sig)}`;
}

describe("access", () => {
	it("bypasses only in development with github base and no team/aud", () => {
		expect(
			accessBypass(env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:1" })),
		).toBe(true);
		expect(
			accessBypass(
				env({
					ENVIRONMENT: "development",
					GITHUB_API_BASE: "http://127.0.0.1:1",
					CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
				}),
			),
		).toBe(false);
		expect(accessBypass(env({ ENVIRONMENT: "production" }))).toBe(false);
	});

	it("verifies RS256 jwt claims and rejects bad tokens", async () => {
		const pair = (await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
			kid?: string;
		};
		jwk.kid = "k1";
		const now = Math.floor(Date.now() / 1000);
		const token = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: "giraffe-e2e",
			exp: now + 60,
			nbf: now - 10,
			email: "a@b.c",
			name: "Ada",
		});
		const fetchImpl = async () => Response.json({ keys: [jwk] });
		const id = await resolveIdentity(
			new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }),
			env({
				ENVIRONMENT: "test",
				CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
				CF_ACCESS_AUD: "giraffe-e2e",
				ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
			}),
			fetchImpl,
		);
		expect(id).toEqual({ email: "a@b.c", name: "Ada" });
		const noExp = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: "giraffe-e2e",
			email: "a@b.c",
		});
		expect(
			(
				await resolveIdentity(
					new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": noExp } }),
					env({
						ENVIRONMENT: "test",
						CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
						CF_ACCESS_AUD: "giraffe-e2e",
						ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
					}),
					fetchImpl,
				)
			).email,
		).toBe("a@b.c");
		const arrayAud = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: ["giraffe-e2e"],
			exp: now + 60,
			email: "a@b.c",
		});
		expect(
			(
				await resolveIdentity(
					new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": arrayAud } }),
					env({
						ENVIRONMENT: "test",
						CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
						CF_ACCESS_AUD: "giraffe-e2e",
						ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
					}),
					fetchImpl,
				)
			).email,
		).toBe("a@b.c");
		const tampered = `${token.split(".").slice(0, 2).join(".")}.aa`;
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": tampered } }),
				env({
					ENVIRONMENT: "test",
					CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
					CF_ACCESS_AUD: "giraffe-e2e",
					ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
				}),
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me"),
				env({ ENVIRONMENT: "production" }),
				fetchImpl,
			),
		).rejects.toBeInstanceOf(ApiError);
		const bypassed = await resolveIdentity(
			new Request("http://x/api/me"),
			env({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://127.0.0.1:1" }),
		);
		expect(bypassed.email).toBe("dev@local");
		await expect(
			resolveIdentity(new Request("http://x/api/me"), env({ ENVIRONMENT: "test" }), fetchImpl),
		).rejects.toMatchObject({ code: "access_misconfigured" });
		const expired = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: "giraffe-e2e",
			exp: now - 10,
			email: "a@b.c",
		});
		const hs = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256" })))}.a.b`;
		const testEnv = env({
			ENVIRONMENT: "test",
			CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:17047",
			CF_ACCESS_AUD: "giraffe-e2e",
			ACCESS_JWKS_URL: "http://127.0.0.1:17047/cdn-cgi/access/certs",
		});
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": expired } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }),
				testEnv,
				async () => new Response("no", { status: 500 }),
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": hs } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": "nope" } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }),
				testEnv,
				async () => Response.json({ keys: [] }),
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		const noEmail = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: "giraffe-e2e",
			exp: now + 60,
			nbf: now - 1,
		});
		const future = await signJwt(pair.privateKey, {
			iss: "http://127.0.0.1:17047",
			aud: "giraffe-e2e",
			exp: now + 60,
			nbf: now + 60,
			email: "a@b.c",
		});
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": noEmail } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": future } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
		const badIss = await signJwt(pair.privateKey, {
			iss: "https://evil.example",
			aud: "giraffe-e2e",
			exp: now + 60,
			email: "a@b.c",
		});
		await expect(
			resolveIdentity(
				new Request("http://x/api/me", { headers: { "Cf-Access-Jwt-Assertion": badIss } }),
				testEnv,
				fetchImpl,
			),
		).rejects.toMatchObject({ code: "access_unauthorized" });
	});
});
