import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FactorySnapshot } from "../../apps/web/src/lib/factory-types";
import { executeD1FixtureSync } from "../fixtures/d1";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { savedSnapshotSql } from "./saved-fixture";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const account = randomUUID().replaceAll("-", "").slice(0, 21);
const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
const at = "2026-10-18T00:00:00.000Z";
const publication = factoryFixture();
let originalActive: string | null = null;
let seeded = false;

function rows(command: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		base !== "http://127.0.0.1:17045" ||
		!persist ||
		!config ||
		resolve(persist) !== resolve(".wrangler/e2e") ||
		resolve(config) !== resolve(".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");
	const result = executeD1FixtureSync(command, { persist, config });
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(statement) => statement.results,
	);
}

function assertMarker() {
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function snapshot(kind: string, value: object) {
	return savedSnapshotSql(account, kind, { ...value }, at);
}

beforeAll(() => {
	assertMarker();
	originalActive = (rows("SELECT id FROM accounts WHERE is_active=1")[0]?.id as string) ?? null;
	const repo = publication.repos[0];
	if (!repo) throw new Error("factory fixture missing");
	publication.account_id = account;
	publication.status = "complete";
	publication.runId = `publication-${account}`;
	publication.publication = { runId: publication.runId, mixed: true, publishedAt: at };
	publication.window = { since: "2026-07-20T00:00:00.000Z", until: at };
	publication.repos = ["nocoo/app", "nocoo/disabled", "nocoo/removed"].map((name) => ({
		...repo,
		id: `R_${name}`,
		name,
		observation: {
			version: `repository-${account}`,
			window: publication.window,
			refreshedAt: "2026-10-17T00:00:00.000Z",
			source: "legacy",
		},
	}));
	publication.inventory.excluded = [{ name: "nocoo/removed", reason: "archived" }];
	const counts = [48, 350, 329, 209, 298, 375];
	publication.contribution = {
		days: Array.from({ length: 90 }, (_, index) => ({
			date: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
			count: index < 84 ? index % 7 : (counts[index - 84] as number),
		})),
		total: 1861,
		restricted: 71,
		fetchedAt: at,
	};
	publication.contributionObservation = {
		version: `calendar-${account}`,
		window: publication.window,
		fetchedAt: at,
	};
	const now = new Date().toISOString();
	seeded = true;
	rows(
		[
			"UPDATE accounts SET is_active=0 WHERE is_active=1;",
			`INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(${quote(account)},'nocoo','test-not-an-encrypted-pat','fake',1,${quote(now)},${quote(now)});`,
			`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(account)},${quote(account)},${quote(createHash("sha256").update(bearer).digest("hex"))},'factory calendar L2','["observations:read"]','local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`,
			snapshot("repos", {
				repos: [{ name_with_owner: "nocoo/app" }, { name_with_owner: "nocoo/disabled" }],
				fetched_at: at,
				truncated: false,
			}),
			snapshot(`factory:v:${publication.runId}`, publication),
			`INSERT INTO repo_stars(account_id,repo) VALUES(${quote(account)},'NOCOO/APP'),(${quote(account)},'nocoo/removed');`,
			`INSERT INTO repo_statistics VALUES(${quote(account)},'nocoo/disabled',0);`,
		].join("\n"),
	);
});

afterAll(() => {
	if (!seeded) return;
	assertMarker();
	rows(
		`DELETE FROM accounts WHERE id=${quote(account)};${originalActive ? `UPDATE accounts SET is_active=1 WHERE id=${quote(originalActive)};` : ""}`,
	);
});

it.each(["complete", "pending", "unavailable"] as const)(
	"preserves all 90 saved calendar days and %s provenance over read-only factory HTTP",
	async (status) => {
		assertMarker();
		publication.contributionStatus = status;
		rows(snapshot("factory", publication));
		const saved = () =>
			rows(
				`SELECT kind,payload,fetched_at FROM refresh_snapshots WHERE account_id=${quote(account)} ORDER BY kind; SELECT * FROM api_tokens WHERE account_id=${quote(account)}; SELECT * FROM refresh_publications WHERE account_id=${quote(account)}; SELECT * FROM accounts ORDER BY id;`,
			);
		const before = saved();
		const countBefore = await (await fetch("http://127.0.0.1:17046/_count")).text();
		for (const machine of [false, true]) {
			for (const selector of ["", "?scope=all", "?scope=starred"]) {
				const response = await fetch(
					`${base}/api/${machine ? `v1/accounts/${account}/` : ""}factory${selector}`,
					{
						headers: machine
							? { authorization: `Bearer ${bearer}` }
							: process.env.GIRAFFE_JWT
								? { "Cf-Access-Jwt-Assertion": process.env.GIRAFFE_JWT }
								: {},
					},
				);
				expect(response.status).toBe(200);
				const body = await response.json();
				const data = (machine ? (body as { data: FactorySnapshot }).data : body) as FactorySnapshot;
				const starred = selector === "?scope=starred";
				expect(data.repos.map((repo) => repo.name)).toEqual(
					!starred ? ["nocoo/app", "nocoo/disabled"] : ["nocoo/app"],
				);
				expect(data.inventory.excluded).toEqual([]);
				expect(data.window).toEqual(publication.window);
				expect(data.publication).toEqual(publication.publication);
				if (starred) {
					expect(data.contribution).toBeNull();
					expect(data.contributionExcluded).toBe(true);
					expect(data.contributionStatus).toBe("unavailable");
					expect(data).not.toHaveProperty("contributionObservation");
				} else {
					expect(data.contribution).toEqual(publication.contribution);
					expect(data.contribution?.days).toHaveLength(90);
					expect(data.contribution?.days.slice(-6).map((day) => day.count)).toEqual([
						48, 350, 329, 209, 298, 375,
					]);
					expect(data.contributionStatus).toBe(status);
					expect(data.contributionObservation).toEqual(publication.contributionObservation);
					expect(data).not.toHaveProperty("contributionExcluded");
				}
				if (machine) {
					expect(body).toMatchObject({
						sourceVersion: publication.runId,
						source: { publicationId: publication.runId },
					});
				}
			}
		}
		expect(saved()).toEqual(before);
		expect(await (await fetch("http://127.0.0.1:17046/_count")).text()).toBe(countBefore);
	},
);
