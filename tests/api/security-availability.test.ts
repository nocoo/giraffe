import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { factoryFixture } from "../fixtures/factory-snapshot";
import { quote, localD1Rows as rows } from "./local-d1";
import { savedSnapshotSql } from "./saved-fixture";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";

it.each([
	["alerts_disabled", false, false],
	["permission_denied", false, false],
	["not_found", false, false],
	["unknown", false, false],
	["code_scanning_disabled", true, false],
	["alerts_disabled", false, true],
	[null, true, true],
] as const)(
	"reads saved security coverage %s (%s/%s) without recollecting or fabricating unavailable counts",
	async (reason, dependabotAvailable, codeScanningAvailable) => {
		const account = randomUUID().replaceAll("-", "").slice(0, 21);
		const owner = `security-${account}`;
		const repository = `${owner}/hello-world`;
		const bearer = `giraffe_${randomBytes(32).toString("base64url")}`;
		const now = new Date().toISOString();
		const at = "2026-10-22T00:00:00.000Z";
		const publication = factoryFixture();
		publication.account_id = account;
		publication.owner = owner;
		publication.runId = `saved-${account}`;
		publication.status = "complete";
		const repo = publication.repos[0];
		if (!repo) throw new Error("factory fixture missing");
		repo.name = repository;
		repo.coverage.alerts = {
			status: dependabotAvailable ? "complete" : "unavailable",
			pages: dependabotAvailable ? 1 : 0,
			fetchedAt: at,
			source: "saved",
			reason,
			...(reason && !dependabotAvailable ? { reason_code: reason } : {}),
			observed: dependabotAvailable ? 1 : 0,
		};
		const security = {
			unavailable: !dependabotAvailable && !codeScanningAvailable,
			dependabot_open: dependabotAvailable ? 1 : null,
			code_scanning_open: codeScanningAvailable ? 0 : null,
			features: {
				dependabot: {
					status: dependabotAvailable ? "available" : "unavailable",
					reason_code: dependabotAvailable ? null : reason,
				},
				code_scanning: {
					status: codeScanningAvailable ? "available" : "unavailable",
					reason_code: codeScanningAvailable ? null : reason,
				},
			},
		};
		const items = dependabotAvailable
			? [{ id: "saved-alert", source: "dependabot", severity: "low", summary: "Saved advisory" }]
			: [];
		const snapshot = (kind: string, value: object) =>
			savedSnapshotSql(account, kind, { fetched_at: at, truncated: false, ...value }, at);
		rows(
			[
				`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${quote(account)},${quote(owner)},'test-not-an-encrypted-pat','fake',${quote(now)},${quote(now)});`,
				`INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${quote(account)},${quote(account)},${quote(createHash("sha256").update(bearer).digest("hex"))},'security L2','["observations:read"]','local test',${quote(now)},${quote(new Date(Date.now() + 86400_000).toISOString())});`,
				snapshot("repos", { repos: [{ name_with_owner: repository, owner_login: owner }] }),
				snapshot(`repo:${repository}:security`, security),
				snapshot(`factory:v:${publication.runId}`, publication),
				snapshot(`factory:${repository}:alerts`, {
					runId: publication.runId,
					repo: repository,
					stream: "alerts",
					coverage: repo.coverage.alerts,
					items,
				}),
			].join("\n"),
		);
		const machine = (path: string) =>
			fetch(`${base}/api/v1/accounts/${account}/${path}`, {
				headers: { Authorization: `Bearer ${bearer}`, connection: "close" },
			});
		const state = () =>
			rows(
				`SELECT * FROM refresh_snapshots WHERE account_id=${quote(account)} ORDER BY kind; SELECT * FROM api_tokens WHERE account_id=${quote(account)}; SELECT * FROM refresh_publications WHERE account_id=${quote(account)}; SELECT * FROM refresh_resources WHERE account_id=${quote(account)} ORDER BY repo_id,stream;`,
			);
		try {
			const before = state();
			const count = await (
				await fetch("http://127.0.0.1:17046/_count", { headers: { connection: "close" } })
			).text();
			const response = await machine(`repos/${repository}/security`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				unavailable: security.unavailable,
				truncated: false,
				data: security,
			});
			const stream = await machine(`factory/repos/${repository}/alerts`);
			expect(stream.status).toBe(200);
			expect(await stream.json()).toMatchObject({
				unavailable: !dependabotAvailable,
				data: { items, coverage: repo.coverage.alerts },
			});
			const sources = await machine("sources");
			expect(sources.status).toBe(200);
			expect(await sources.json()).toMatchObject({
				sources: expect.arrayContaining([
					expect.objectContaining({
						resource: `factory:${repository}:alerts`,
						unavailable: !dependabotAvailable,
						coverage: expect.objectContaining({ status: repo.coverage.alerts.status }),
					}),
				]),
			});
			expect(state()).toEqual(before);
			expect(
				await (
					await fetch("http://127.0.0.1:17046/_count", { headers: { connection: "close" } })
				).text(),
			).toBe(count);
		} finally {
			rows(`DELETE FROM accounts WHERE id=${quote(account)};`);
		}
	},
);
