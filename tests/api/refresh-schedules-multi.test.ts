import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { executeD1FixtureSync } from "../fixtures/d1";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const root = resolve(import.meta.dirname, "../..");
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function rows(sql: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		new URL(base).hostname !== "127.0.0.1" ||
		persist !== join(root, ".wrangler/e2e") ||
		config !== join(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 context required");
	const result = executeD1FixtureSync(sql, { persist, config, root });
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(entry) => entry.results,
	);
}

it("roundtrips multiple schedule slots over local HTTP without tokenless writes or GET side effects", async () => {
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
	const account = randomUUID().replaceAll("-", "").slice(0, 21);
	const token = () => `giraffe_${createHash("sha256").update(randomUUID()).digest("base64url")}`;
	const bearer = token(),
		reader = token();
	const now = new Date().toISOString();
	const expires = new Date(Date.now() + 86400_000).toISOString();
	rows(`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${literal(account)},${literal(`schedule-${account}`)},'test-not-an-encrypted-pat','fake',${literal(now)},${literal(now)});
${[
	[bearer, '["app:read","app:write"]'],
	[reader, '["app:read"]'],
]
	.map(
		([raw, scopes]) =>
			`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${literal(randomUUID())},${literal(account)},${literal(
				createHash("sha256")
					.update(raw ?? "")
					.digest("hex"),
			)},'schedule L2',${literal(scopes ?? "")},'local test',${literal(now)},${literal(expires)});`,
	)
	.join("\n")}`);
	const api = (path: string, method = "GET", body?: unknown, auth: string | null = bearer) =>
		fetch(`${base}/api/v1/accounts/${account}/${path}`, {
			method,
			headers: {
				...(auth ? { authorization: `Bearer ${auth}` } : {}),
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		for (const kind of ["daily", "weekly", "catalog"]) {
			const body = {
				enabled: false,
				weekday: kind === "weekly" ? 3 : 0,
				scope: kind === "daily" ? "starred" : "all",
			};
			const saved = await api(`schedules/${kind}`, "PUT", {
				...body,
				times: ["19:30", "05:30", "05:30"],
			});
			expect(saved.status).toBe(200);
			expect(await saved.json()).toMatchObject({
				schedules: expect.arrayContaining([
					expect.objectContaining({ kind, ...body, time: "05:30", times: ["05:30", "19:30"] }),
				]),
			});
			for (const patch of [
				{ times: [] },
				{ times: ["25:00"] },
				{ times: ["5:30"] },
				{ times: ["05:30", "19:30"], time: "19:30" },
				{ times: ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"] },
				{ time: "19:30", extra: true },
				{},
			]) {
				const invalid = await api(`schedules/${kind}`, "PUT", { ...body, ...patch });
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
			}
			const six = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"];
			expect(
				(await api(`schedules/${kind}`, "PUT", { ...body, time: "00:00", times: six })).status,
			).toBe(200);
			const legacy = await api(`schedules/${kind}`, "PUT", { ...body, time: "19:30" });
			expect(await legacy.json()).toMatchObject({
				schedules: expect.arrayContaining([
					expect.objectContaining({ kind, time: "19:30", times: ["19:30"] }),
				]),
			});
			for (const [auth, status] of [
				[null, 401],
				["invalid", 401],
				[reader, 403],
			] as const)
				expect(
					(await api(`schedules/${kind}`, "PUT", { ...body, time: "19:30" }, auth)).status,
				).toBe(status);
			expect((await api(`schedules/${kind}`, "POST", { ...body, time: "19:30" })).status).toBe(405);
		}
		const snapshot = () =>
			rows(
				`SELECT 'schedule' AS type,kind,times AS payload FROM refresh_schedule_times WHERE account_id=${literal(account)} UNION ALL SELECT 'token',id,COALESCE(last_used_at,'') FROM api_tokens WHERE account_id=${literal(account)} ORDER BY type,kind`,
			);
		const before = snapshot();
		const read = await api("settings");
		expect(read.status).toBe(200);
		expect(read.headers.get("cache-control")).toBe("private, no-store");
		expect((await api("settings")).status).toBe(200);
		expect(snapshot()).toEqual(before);
		for (const kind of ["daily", "weekly", "catalog"])
			expect((await api(`schedules/${kind}`, "DELETE")).status).toBe(204);
		expect(
			rows(`SELECT * FROM refresh_schedule_times WHERE account_id=${literal(account)}`),
		).toEqual([]);
	} finally {
		expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
		rows(`DELETE FROM accounts WHERE id=${literal(account)}`);
	}
});
