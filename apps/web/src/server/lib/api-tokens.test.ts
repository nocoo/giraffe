import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import {
	API_SCOPES,
	type CreateApiTokenInput,
	createApiTokenSchema,
	createAuthorizationCodeSchema,
	exchangeAuthorizationCodeSchema,
	updateApiTokenSchema,
} from "../../lib/api-access";
import {
	authenticateApiToken,
	createApiToken,
	createAuthorizationCode,
	exchangeAuthorizationCode,
	listApiTokens,
	recordApiTokenUse,
	revokeApiToken,
	updateApiToken,
} from "./api-tokens";
import { createDb } from "./db/d1";

const accountId = "aaaaaaaaaaaaaaaaaaaaa";
const otherAccountId = "bbbbbbbbbbbbbbbbbbbbb";
const now = "2026-10-02T10:00:00.000Z";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const redirectUri = "http://127.0.0.1:45678/callback";
const draft: CreateApiTokenInput = {
	accountId,
	label: "Local agent",
	scopes: ["observations:read", "agent:write"],
	creator: "owner@example.com",
};
const consent = {
	...draft,
	redirectUri,
	state: "opaque-client-state",
	codeChallenge: challenge,
};

async function fixture() {
	const raw = sqliteFixture();
	const migration = readFileSync("migrations/0011_api_access.sql", "utf8");
	await raw.batch(
		migration
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean)
			.map((statement) => raw.prepare(statement)),
	);
	for (const id of [accountId, otherAccountId]) {
		await raw
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,'{}','test',?,?)",
			)
			.bind(id, id, now, now)
			.run();
	}
	return { raw, db: createDb(raw) };
}

async function storedTokens(raw: D1Database) {
	return (await raw.prepare("SELECT * FROM api_tokens ORDER BY id").all()).results;
}

async function storedCodes(raw: D1Database) {
	return (await raw.prepare("SELECT * FROM api_authorization_codes").all()).results;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("API access schemas", () => {
	it("has exactly the approved scopes and defaults to thirty days", () => {
		expect(API_SCOPES).toEqual([
			"observations:read",
			"agent:read",
			"agent:write",
			"app:read",
			"app:write",
		]);
		expect(createApiTokenSchema.parse({ ...draft, label: "  Agent  " })).toEqual({
			...draft,
			label: "Agent",
			expiresInDays: 30,
		});
		expect(createApiTokenSchema.safeParse({ ...draft, scopes: [...API_SCOPES] }).success).toBe(
			true,
		);
	});

	it.each([0, -1, 91, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30", null])(
		"rejects invalid expiry %s",
		(expiresInDays) => {
			expect(createApiTokenSchema.safeParse({ ...draft, expiresInDays }).success).toBe(false);
		},
	);

	it.each([
		{ scopes: [] },
		{ scopes: ["admin"] },
		{ scopes: ["agent:read", "agent:read"] },
		{ scopes: ["agent:READ"] },
		{ scopes: ["app:write", "*"] },
	])("rejects invalid scopes $scopes", ({ scopes }) => {
		expect(createApiTokenSchema.safeParse({ ...draft, scopes }).success).toBe(false);
		expect(updateApiTokenSchema.safeParse({ scopes }).success).toBe(false);
	});

	it.each(["", "   ", "a".repeat(121), "Agent\nsecret", "Agent\u0000"])(
		"rejects invalid labels %j",
		(label) => {
			expect(createApiTokenSchema.safeParse({ ...draft, label }).success).toBe(false);
		},
	);

	it("rejects missing identity and fields that could rebind or extend a token", () => {
		for (const creator of ["", "   ", "a".repeat(321), "owner\nsecret"]) {
			expect(createApiTokenSchema.safeParse({ ...draft, creator }).success).toBe(false);
		}
		expect(createApiTokenSchema.safeParse({ ...draft, accountId: "" }).success).toBe(false);
		expect(createApiTokenSchema.safeParse({ ...draft, token: "chosen-secret" }).success).toBe(
			false,
		);
		expect(updateApiTokenSchema.safeParse({}).success).toBe(false);
		for (const extra of [
			{ accountId: otherAccountId },
			{ creator: "other@example.com" },
			{ expiresInDays: 90 },
			{ revoked_at: null },
		]) {
			expect(updateApiTokenSchema.safeParse({ label: "Changed", ...extra }).success).toBe(false);
		}
	});
});

describe("API tokens", () => {
	it("creates random opaque tokens and persists only their SHA-256 hashes", async () => {
		const { raw, db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const second = await createApiToken(db, draft, now);
		expect(created.token).toMatch(/^giraffe_[A-Za-z0-9_-]{43}$/);
		expect(second.token).not.toBe(created.token);
		expect(second.id).not.toBe(created.id);
		expect(created).toEqual({
			id: expect.any(String),
			account_id: accountId,
			label: draft.label,
			scopes: draft.scopes,
			creator: draft.creator,
			created_at: now,
			expires_at: "2026-11-01T10:00:00.000Z",
			revoked_at: null,
			last_used_at: null,
			token: expect.any(String),
		});
		const rows = await storedTokens(raw);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.id === created.id)?.token_hash).toBe(
			createHash("sha256").update(created.token).digest("hex"),
		);
		for (const token of [created.token, second.token]) {
			expect(JSON.stringify(rows)).not.toContain(token);
		}
	});

	it.each([1, 90])("accepts the finite expiry boundary %s", async (expiresInDays) => {
		const { db } = await fixture();
		const created = await createApiToken(db, { ...draft, expiresInDays }, now);
		expect(Date.parse(created.expires_at) - Date.parse(now)).toBe(expiresInDays * 86_400_000);
	});

	it("uses the current time by default", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(now));
		const { db } = await fixture();
		const created = await createApiToken(db, draft);
		expect(created.created_at).toBe(now);
		expect(await authenticateApiToken(db, `Bearer ${created.token}`)).toEqual({
			id: created.id,
			accountId,
			scopes: draft.scopes,
			expiresAt: created.expires_at,
		});
	});

	it("rejects invalid requests and missing accounts without minting", async () => {
		const { raw, db } = await fixture();
		await expect(createApiToken(db, { ...draft, label: "" }, now)).rejects.toMatchObject({
			status: 400,
			code: "validation_failed",
		});
		await expect(
			createApiToken(db, { ...draft, accountId: "ccccccccccccccccccccc" }, now),
		).rejects.toMatchObject({ status: 404, code: "account_not_found" });
		expect(await storedTokens(raw)).toEqual([]);
	});

	it("lists only public account-bound metadata, newest first", async () => {
		const { db } = await fixture();
		const first = await createApiToken(db, draft, now);
		const second = await createApiToken(db, draft, "2026-10-02T10:01:00.000Z");
		await createApiToken(db, { ...draft, accountId: otherAccountId }, now);
		const listed = await listApiTokens(db, accountId);
		expect(listed.map((token) => token.id)).toEqual([second.id, first.id]);
		for (const token of listed) {
			expect(token).not.toHaveProperty("token");
			expect(token).not.toHaveProperty("token_hash");
			expect(token.account_id).toBe(accountId);
		}
		expect(await listApiTokens(db, "missing")).toEqual([]);
	});

	it("authenticates read-only and never follows the active account", async () => {
		const { raw, db } = await fixture();
		const created = await createApiToken(db, draft, now);
		await raw.prepare("UPDATE accounts SET is_active=1 WHERE id=?").bind(otherAccountId).run();
		const before = await raw.prepare("SELECT total_changes() AS count").first();
		const prepare = vi.spyOn(db, "prepare");
		for (const scheme of ["Bearer", "bearer", "BEARER"]) {
			expect(await authenticateApiToken(db, `${scheme} ${created.token}`, now)).toEqual({
				id: created.id,
				accountId,
				scopes: draft.scopes,
				expiresAt: created.expires_at,
			});
		}
		await listApiTokens(db, accountId);
		expect(prepare.mock.calls.every(([sql]) => /^SELECT\b/i.test(sql.trim()))).toBe(true);
		expect(await raw.prepare("SELECT total_changes() AS count").first()).toEqual(before);
		expect((await listApiTokens(db, accountId))[0]?.last_used_at).toBeNull();
	});

	it.each([
		undefined,
		null,
		"",
		"Basic giraffe_secret",
		"Bearer",
		"Bearer giraffe_short",
		`Bearer giraffe_${"a".repeat(43)}\n`,
		`Bearer giraffe_${"a".repeat(43)} trailing`,
		`Bearer giraffe_${"a".repeat(43)},giraffe_${"b".repeat(43)}`,
		`Bearer giraffe_code_${"a".repeat(43)}`,
	])("rejects malformed authorization %j without querying storage", async (authorization) => {
		const { db } = await fixture();
		const prepare = vi.spyOn(db, "prepare");
		expect(await authenticateApiToken(db, authorization, now)).toBeNull();
		expect(prepare).not.toHaveBeenCalled();
	});

	it("rejects unknown, expired and revoked tokens at exact boundaries", async () => {
		const { db } = await fixture();
		const created = await createApiToken(db, { ...draft, expiresInDays: 1 }, now);
		const authorization = `Bearer ${created.token}`;
		expect(await authenticateApiToken(db, `Bearer giraffe_${"z".repeat(43)}`, now)).toBeNull();
		expect(await authenticateApiToken(db, authorization, "2026-10-03T09:59:59.999Z")).not.toBe(
			null,
		);
		expect(await authenticateApiToken(db, authorization, created.expires_at)).toBeNull();
		expect(await authenticateApiToken(db, authorization, "2026-10-04T10:00:00.000Z")).toBeNull();
		expect(await revokeApiToken(db, accountId, created.id, now)).toBe(true);
		expect(await authenticateApiToken(db, authorization, now)).toBeNull();
	});

	it("allows renaming and irreversible scope reduction without returning secrets", async () => {
		const { db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const renamed = await updateApiToken(db, accountId, created.id, { label: "  CLI  " }, now);
		expect(renamed).toMatchObject({ label: "CLI", scopes: draft.scopes });
		const reduced = await updateApiToken(
			db,
			accountId,
			created.id,
			{ scopes: ["observations:read"] },
			now,
		);
		expect(reduced).toMatchObject({ label: "CLI", scopes: ["observations:read"] });
		expect(reduced).not.toHaveProperty("token");
		expect(reduced).not.toHaveProperty("token_hash");
		await expect(
			updateApiToken(db, accountId, created.id, { scopes: draft.scopes }, now),
		).rejects.toMatchObject({ status: 403, code: "scope_escalation" });
		await expect(
			updateApiToken(db, accountId, created.id, { scopes: ["app:write"] }, now),
		).rejects.toMatchObject({ status: 403, code: "scope_escalation" });
		expect(await authenticateApiToken(db, `Bearer ${created.token}`, now)).toMatchObject({
			scopes: ["observations:read"],
		});
	});

	it("blocks cross-account mutation and preserves the original revocation timestamp", async () => {
		const { raw, db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const before = await storedTokens(raw);
		expect(
			await updateApiToken(db, otherAccountId, created.id, { label: "Other" }, now),
		).toBeNull();
		expect(await revokeApiToken(db, otherAccountId, created.id, now)).toBe(false);
		expect(await revokeApiToken(db, accountId, "missing", now)).toBe(false);
		expect(await storedTokens(raw)).toEqual(before);
		expect(await revokeApiToken(db, accountId, created.id, now)).toBe(true);
		expect(await revokeApiToken(db, accountId, created.id, "2026-10-02T11:00:00.000Z")).toBe(true);
		expect((await listApiTokens(db, accountId))[0]?.revoked_at).toBe(now);
		expect(await updateApiToken(db, accountId, created.id, { label: "Revived" }, now)).toBeNull();
	});

	it("does not edit expired tokens or accept empty updates", async () => {
		const { db } = await fixture();
		const created = await createApiToken(db, draft, now);
		expect(
			await updateApiToken(db, accountId, created.id, { label: "Expired" }, created.expires_at),
		).toBeNull();
		await expect(updateApiToken(db, accountId, created.id, {}, now)).rejects.toMatchObject({
			code: "validation_failed",
		});
	});

	it("does not restore scopes when reductions race", async () => {
		const { db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const outcomes = await Promise.allSettled([
			updateApiToken(db, accountId, created.id, { scopes: ["observations:read"] }, now),
			updateApiToken(db, accountId, created.id, { scopes: ["agent:write"] }, now),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
			reason: { status: 409, code: "token_changed" },
		});
		expect((await listApiTokens(db, accountId))[0]?.scopes).toHaveLength(1);
	});

	it("records usage only explicitly, monotonically, and within its account and lifetime", async () => {
		const { db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const usedAt = "2026-10-02T10:01:00.000Z";
		expect(await recordApiTokenUse(db, otherAccountId, created.id, usedAt)).toBe(false);
		expect(await recordApiTokenUse(db, accountId, "missing", usedAt)).toBe(false);
		expect(await recordApiTokenUse(db, accountId, created.id, usedAt)).toBe(true);
		expect(await recordApiTokenUse(db, accountId, created.id, now)).toBe(false);
		expect((await listApiTokens(db, accountId))[0]?.last_used_at).toBe(usedAt);
		expect(await recordApiTokenUse(db, accountId, created.id, created.expires_at)).toBe(false);
		await revokeApiToken(db, accountId, created.id, usedAt);
		expect(await recordApiTokenUse(db, accountId, created.id, usedAt)).toBe(false);
	});

	it("fails closed on corrupted stored permissions without exposing their content", async () => {
		const { raw, db } = await fixture();
		const created = await createApiToken(db, draft, now);
		await raw
			.prepare("UPDATE api_tokens SET scopes=? WHERE id=?")
			.bind('["secret-database-detail"]', created.id)
			.run();
		await expect(authenticateApiToken(db, `Bearer ${created.token}`, now)).rejects.toMatchObject({
			status: 500,
			code: "db_error",
			message: "Invalid API access record",
		});
		await expect(listApiTokens(db, accountId)).rejects.toMatchObject({ code: "db_error" });
	});
});

describe("PKCE authorization codes", () => {
	it("stores only the hash of a five-minute authorization code, never the raw code or state", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		expect(issued).toEqual({
			code: expect.stringMatching(/^giraffe_code_[A-Za-z0-9_-]{43}$/),
			redirectUri,
			state: consent.state,
			expiresAt: "2026-10-02T10:05:00.000Z",
		});
		const rows = await storedCodes(raw);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			code_hash: createHash("sha256").update(issued.code).digest("hex"),
			account_id: accountId,
			code_challenge: challenge,
			expires_in_days: 30,
			consumed_at: null,
			token_id: null,
		});
		expect(JSON.stringify(rows)).not.toContain(issued.code);
		expect(JSON.stringify(rows)).not.toContain(verifier);
		expect(JSON.stringify(rows)).not.toContain(consent.state);
		expect(await listApiTokens(db, accountId)).toEqual([]);
	});

	it("removes at most one hundred expired grants per creation without touching live codes", async () => {
		const { raw, db } = await fixture();
		await raw.batch(
			Array.from({ length: 102 }, (_, index) =>
				raw
					.prepare(
						"INSERT INTO api_authorization_codes(code_hash,account_id,label,scopes,creator,expires_in_days,redirect_uri,code_challenge,created_at,expires_at) VALUES(?,?,?,?,?,30,?,?,?,?)",
					)
					.bind(
						index.toString(16).padStart(64, "0"),
						accountId,
						draft.label,
						JSON.stringify(draft.scopes),
						draft.creator,
						redirectUri,
						challenge,
						"2026-10-02T09:55:00.000Z",
						now,
					),
			),
		);
		const live = await createAuthorizationCode(db, consent, "2026-10-02T09:59:59.999Z");
		expect(await storedCodes(raw)).toHaveLength(103);
		await createAuthorizationCode(db, { ...consent, accountId: otherAccountId }, now);
		const after = await storedCodes(raw);
		expect(after).toHaveLength(4);
		expect(after.filter((code) => code.expires_at === now)).toHaveLength(2);
		await expect(
			exchangeAuthorizationCode(db, { code: live.code, codeVerifier: verifier, redirectUri }, now),
		).resolves.toHaveProperty("token");
		await createAuthorizationCode(db, consent, now);
		expect((await storedCodes(raw)).some((code) => code.expires_at === now)).toBe(false);
	});

	it.each([
		"http://localhost:1/callback",
		"http://localhost:80/callback",
		"http://127.0.0.1:65535/callback",
	])("accepts exact loopback callback %s", (callback) => {
		expect(
			createAuthorizationCodeSchema.safeParse({ ...consent, redirectUri: callback }).success,
		).toBe(true);
	});

	it.each([
		"https://127.0.0.1:45678/callback",
		"http://localhost/callback",
		"http://localhost:0/callback",
		"http://localhost:65536/callback",
		"http://localhost:999999/callback",
		"http://localhost:080/callback",
		"http://localhost:80/callback/",
		"http://localhost:80/Callback",
		"http://localhost:80/call%62ack",
		"http://localhost:80/other/../callback",
		"http://localhost:80/callback?",
		"http://localhost:80/callback?code=secret",
		"http://localhost:80/callback#",
		"http://localhost:80/callback#fragment",
		"http://name:secret@localhost:80/callback",
		"http://@localhost:80/callback",
		"http://localhost.evil.example:80/callback",
		"http://127.0.0.2:80/callback",
		"http://2130706433:80/callback",
		"http://0x7f000001:80/callback",
		"http://[::1]:80/callback",
		"http://127.0.0.1.:80/callback",
		"http:\\localhost:80\\callback",
		"http://localhost:80/callback\n",
		" http://localhost:80/callback",
	])("rejects unsafe callback %j", (callback) => {
		expect(
			createAuthorizationCodeSchema.safeParse({ ...consent, redirectUri: callback }).success,
		).toBe(false);
	});

	it("preserves bounded opaque state and rejects controls", () => {
		for (const state of ["x", "opaque +/=:%&", "a".repeat(512)]) {
			expect(createAuthorizationCodeSchema.parse({ ...consent, state }).state).toBe(state);
		}
		for (const state of ["", "a".repeat(513), "state\n", "state\u0000"]) {
			expect(createAuthorizationCodeSchema.safeParse({ ...consent, state }).success).toBe(false);
		}
	});

	it("requires a base64url S256 challenge and an RFC7636 verifier", () => {
		for (const codeChallenge of [
			"a".repeat(42),
			"a".repeat(44),
			`${"a".repeat(42)}+`,
			`${"a".repeat(42)}=`,
			`${"a".repeat(42)}\n`,
		]) {
			expect(createAuthorizationCodeSchema.safeParse({ ...consent, codeChallenge }).success).toBe(
				false,
			);
		}
		const request = { code: `giraffe_code_${"a".repeat(43)}`, redirectUri };
		for (const codeVerifier of ["a".repeat(43), "a".repeat(128), `${"a".repeat(39)}-._~`]) {
			expect(exchangeAuthorizationCodeSchema.safeParse({ ...request, codeVerifier }).success).toBe(
				true,
			);
		}
		for (const codeVerifier of [
			"a".repeat(42),
			"a".repeat(129),
			`${"a".repeat(43)}+`,
			`${"a".repeat(43)}/`,
			`${"a".repeat(43)}=`,
			`${"a".repeat(43)} `,
			`${"a".repeat(43)}\n`,
		]) {
			expect(exchangeAuthorizationCodeSchema.safeParse({ ...request, codeVerifier }).success).toBe(
				false,
			);
		}
	});

	it("exchanges the RFC7636 vector once and binds the approved account and permissions", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, { ...consent, expiresInDays: 1 }, now);
		await raw.prepare("UPDATE accounts SET is_active=1 WHERE id=?").bind(otherAccountId).run();
		const exchangedAt = "2026-10-02T10:01:00.000Z";
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		const created = await exchangeAuthorizationCode(db, request, exchangedAt);
		expect(created).toMatchObject({
			account_id: accountId,
			label: draft.label,
			scopes: draft.scopes,
			creator: draft.creator,
			created_at: exchangedAt,
			expires_at: "2026-10-03T10:01:00.000Z",
			token: expect.stringMatching(/^giraffe_[A-Za-z0-9_-]{43}$/),
		});
		expect(await authenticateApiToken(db, `Bearer ${created.token}`, exchangedAt)).toEqual({
			id: created.id,
			accountId,
			scopes: draft.scopes,
			expiresAt: created.expires_at,
		});
		expect((await storedCodes(raw))[0]).toMatchObject({
			consumed_at: exchangedAt,
			token_id: created.id,
		});
		await expect(exchangeAuthorizationCode(db, request, exchangedAt)).rejects.toMatchObject({
			status: 400,
			code: "invalid_grant",
		});
		expect(await storedTokens(raw)).toHaveLength(1);
		expect(JSON.stringify(await storedTokens(raw))).not.toContain(created.token);
	});

	it("rejects bad proof, redirect mismatch and unknown codes without burning a valid grant", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		for (const invalid of [
			{ ...request, codeVerifier: "z".repeat(43) },
			{ ...request, codeVerifier: challenge },
			{ ...request, redirectUri: "http://127.0.0.1:45679/callback" },
			{ ...request, redirectUri: "http://localhost:45678/callback" },
			{ ...request, code: `giraffe_code_${"z".repeat(43)}` },
		]) {
			await expect(exchangeAuthorizationCode(db, invalid, now)).rejects.toMatchObject({
				status: 400,
				code: "invalid_grant",
			});
		}
		expect(await storedTokens(raw)).toEqual([]);
		expect((await storedCodes(raw))[0]?.consumed_at).toBeNull();
		await expect(exchangeAuthorizationCode(db, request, now)).resolves.toHaveProperty("token");
	});

	it("expires codes exactly at five minutes", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		await expect(exchangeAuthorizationCode(db, request, issued.expiresAt)).rejects.toMatchObject({
			code: "invalid_grant",
		});
		expect(await storedTokens(raw)).toEqual([]);
		await expect(
			exchangeAuthorizationCode(db, request, "2026-10-02T10:04:59.999Z"),
		).resolves.toHaveProperty("token");
	});

	it("mints exactly one token when two exchanges race", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		const outcomes = await Promise.allSettled([
			exchangeAuthorizationCode(db, request, now),
			exchangeAuthorizationCode(db, request, now),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
			reason: { code: "invalid_grant" },
		});
		expect(await storedTokens(raw)).toHaveLength(1);
	});

	it("guards minting against consumption after the initial lookup", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		const batch = db.batch.bind(db);
		let winnerId = "";
		vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
			winnerId = (await exchangeAuthorizationCode(createDb(raw), request, now)).id;
			return batch(statements);
		});
		await expect(exchangeAuthorizationCode(db, request, now)).rejects.toMatchObject({
			code: "invalid_grant",
		});
		expect((await storedTokens(raw)).map((token) => token.id)).toEqual([winnerId]);
	});

	it("rolls consumption back if minting fails and never exposes the storage error", async () => {
		const { raw, db } = await fixture();
		const issued = await createAuthorizationCode(db, consent, now);
		const request = { code: issued.code, codeVerifier: verifier, redirectUri };
		await raw
			.prepare(
				"CREATE TRIGGER fail_token BEFORE INSERT ON api_tokens BEGIN SELECT RAISE(ABORT,'secret-database-detail'); END",
			)
			.run();
		await expect(exchangeAuthorizationCode(db, request, now)).rejects.toMatchObject({
			status: 500,
			code: "db_error",
			message: "d1 error",
		});
		expect((await storedCodes(raw))[0]).toMatchObject({ consumed_at: null, token_id: null });
		expect(await storedTokens(raw)).toEqual([]);
		await raw.prepare("DROP TRIGGER fail_token").run();
		await expect(exchangeAuthorizationCode(db, request, now)).resolves.toHaveProperty("token");
	});

	it("validates authorization creation and exchange before touching storage", async () => {
		const { db } = await fixture();
		const prepare = vi.spyOn(db, "prepare");
		await expect(
			createAuthorizationCode(db, { ...consent, redirectUri: "https://evil.example" }, now),
		).rejects.toMatchObject({ code: "validation_failed" });
		await expect(
			exchangeAuthorizationCode(db, { code: "raw-secret", codeVerifier: "bad", redirectUri }, now),
		).rejects.toMatchObject({
			code: "validation_failed",
			message: "Invalid API access request",
		});
		expect(prepare).not.toHaveBeenCalled();
	});

	it("removes account tokens and pending consent codes when their account is deleted", async () => {
		const { raw, db } = await fixture();
		const created = await createApiToken(db, draft, now);
		const issued = await createAuthorizationCode(db, consent, now);
		await raw.prepare("DELETE FROM accounts WHERE id=?").bind(accountId).run();
		expect(await storedTokens(raw)).toEqual([]);
		expect(await storedCodes(raw)).toEqual([]);
		expect(await authenticateApiToken(db, `Bearer ${created.token}`, now)).toBeNull();
		await expect(
			exchangeAuthorizationCode(
				db,
				{ code: issued.code, codeVerifier: verifier, redirectUri },
				now,
			),
		).rejects.toMatchObject({ code: "invalid_grant" });
	});
});
