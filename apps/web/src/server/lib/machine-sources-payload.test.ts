import { expect, it, vi } from "vitest";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { readObservation } from "./machine-observations";
import { readSources } from "./machine-sources";

const account = "slim-source-account";
const at = "2026-10-20T00:00:00.000Z";
const repository = "owner/app";
const targets = ["actions", "releases", "details"] as const;
const large = "\u4f60\u597d".repeat(4000);
type SnapshotRow = { kind: string; payload: string; content_meta: string | null };

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'owner','fake','fake',?,?)",
		)
		.bind(account, at, at)
		.run();
	const snapshots = new Map<string, Record<string, unknown>>();
	async function save(kind: string, fields: Record<string, unknown>) {
		const data = { ...fields, fetched_at: at, truncated: fields.truncated === true };
		snapshots.set(kind, data);
		await raw
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?) ON CONFLICT(account_id,kind) DO UPDATE SET payload=excluded.payload,content_meta=excluded.content_meta",
			)
			.bind(
				account,
				kind,
				JSON.stringify(data),
				"not-the-payload-time",
				await savedContentMeta(kind, data),
			)
			.run();
	}
	await save("repos", { repos: [{ name_with_owner: repository }] });
	await save("issues", { issues: [{ name_with_owner: repository, title: large }] });
	await save("prs", { pull_requests: [{ name_with_owner: repository, number: 1 }] });
	await save(`repo:${repository}:issues`, { issues: [{ number: 2, body: large }] });
	await save(`repo:${repository}:prs`, { pull_requests: [{ number: 3, title: large }] });
	const run = {
		id: 1,
		name: "Release",
		html_url: large,
		status: "completed",
		conclusion: "failure",
		event: "push",
		head_branch: "main",
		created_at: at,
		updated_at: large,
	};
	await save(`repo:${repository}:actions`, {
		runs: [
			run,
			{ ...run, id: 2, conclusion: "success", created_at: "2026-10-19T00:00:00Z" },
			{ ...run, id: 3, status: "queued", conclusion: null, head_branch: "feature" },
			{ ...run, id: 4, event: "dynamic", name: "bot" },
		],
		freshness: { oldestAt: at, latestAt: "2026-10-21T00:00:00Z", total: 2, missing: 1 },
		coverage: { status: "partial", retained: true },
		repository_fetched_at: { [repository]: at },
		extension: "preserved",
	});
	await save(`repo:${repository}:releases`, {
		releases: [
			{
				id: 1,
				tag_name: "v1",
				name: large,
				html_url: large,
				draft: false,
				prerelease: true,
				published_at: at,
			},
			{
				id: 2,
				tag_name: "v2",
				name: large,
				html_url: large,
				draft: true,
				prerelease: false,
				published_at: at,
			},
			{ tag_name: "v0", draft: false, published_at: "2026-10-15T00:00:00Z" },
		],
	});
	await save(`repo:${repository}:details`, {
		description: large,
		homepage: large,
		default_branch: "main",
		license: "MIT",
		is_archived: false,
		open_issue_count: 1,
		stargazer_count: 2,
		fork_count: 3,
		pushed_at: at,
		url: large,
		topics: [large],
	});
	async function expected() {
		const resources = [
			...[...snapshots.keys()].filter((kind) => kind.startsWith("repo:")).sort(),
			"account:issues",
			"account:prs",
			"account:ci",
			"account:repos",
		];
		return {
			account_id: account,
			repositories: [repository],
			sources: await Promise.all(
				resources.map(async (resource) => {
					const envelope = await readObservation(
						createDb(raw),
						account,
						resource.replace(/^account:/, ""),
						"all",
					);
					return {
						resource,
						version: envelope.sourceVersion,
						contentVersion: envelope.contentVersion,
						fetchedAt: envelope.fetchedAt,
						freshness: envelope.freshness,
						coverage: envelope.coverage,
						truncated: envelope.truncated,
						unavailable: envelope.unavailable,
					};
				}),
			),
		};
	}
	const saved = async () =>
		(await raw.prepare("SELECT * FROM snapshots ORDER BY kind").all()).results;
	const payloadBytes = async () =>
		(
			await raw
				.prepare("SELECT SUM(length(CAST(payload AS BLOB))) AS bytes FROM snapshots")
				.first<{ bytes: number }>()
		)?.bytes;
	async function read(query: Record<string, string> = {}) {
		const profile = profileDb(raw);
		const batch = vi.spyOn(profile.raw, "batch");
		const result = await readSources(createDb(profile.raw), account, query);
		const batches = (await batch.mock.results[0]?.value) as D1Result<SnapshotRow>[];
		return {
			result,
			profile,
			rows: batches[4]?.results ?? [],
			bytes: profile.queries.reduce((total, statement) => total + statement.payloadBytes, 0),
		};
	}
	return { raw, save, snapshots, expected, saved, payloadBytes, read };
}

it.each([{}, { since: "2099-01-01T00:00:00.000Z" }, { repository }])(
	"reads stored payloads without SQL JSON rewriting: %j",
	async (query) => {
		const source = await fixture();
		const before = await source.saved();
		const originalBytes = await source.payloadBytes();
		const read = await source.read(query);
		if (!("since" in query))
			expect(JSON.stringify(read.result)).toBe(JSON.stringify(await source.expected()));
		else expect(read.result.sources).toEqual([]);
		expect(read.profile.queries).toHaveLength(7);
		expect(read.profile.trips).toHaveLength(1);
		expect(read.bytes).toBe(originalBytes);
		expect(read.profile.queries.map((statement) => statement.sql).join("\n")).not.toMatch(
			/\bjson_(?:set|remove|group_array)\s*\(/i,
		);
		for (const row of read.rows) {
			const original = source.snapshots.get(row.kind);
			if (!original) throw new Error("missing fixture source");
			expect(row.payload).toBe(JSON.stringify(original));
		}
		expect(await source.saved()).toEqual(before);
	},
);

it.each([
	"null",
	"missing-full-version",
	"empty-full-version",
	"empty-hash",
	"non-string-full-version",
	"split-same",
	"split-mismatch",
	"split-null",
])("keeps original payloads for %s fallback", async (mode) => {
	const source = await fixture();
	for (const suffix of targets) {
		const kind = `repo:${repository}:${suffix}`;
		if (mode.startsWith("split")) {
			const root = await source.raw
				.prepare("SELECT payload,content_meta FROM snapshots WHERE kind=?")
				.bind(kind)
				.first<SnapshotRow>();
			if (!root) throw new Error("missing fixture root");
			await source.raw
				.prepare(
					"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
				)
				.bind(
					account,
					`${kind}#2`,
					root.payload,
					at,
					mode === "split-same"
						? root.content_meta
						: mode === "split-null"
							? null
							: '{"hash":"different","fullVersion":"different"}',
				)
				.run();
		} else {
			const metadata: Record<string, string | null> = {
				null: null,
				"missing-full-version": '{"hash":"without-version"}',
				"empty-full-version": '{"hash":"hash","fullVersion":""}',
				"empty-hash": '{"hash":"","fullVersion":"version"}',
				"non-string-full-version": '{"hash":"hash","fullVersion":null}',
			};
			await source.raw
				.prepare("UPDATE snapshots SET content_meta=? WHERE kind=?")
				.bind(metadata[mode] ?? null, kind)
				.run();
		}
	}
	const before = await source.saved();
	const read = await source.read();
	expect(JSON.stringify(read.result)).toBe(JSON.stringify(await source.expected()));
	expect(read.bytes).toBe(await source.payloadBytes());
	expect(await source.saved()).toEqual(before);
});

it("preserves empty arrays, unsupported shapes and invalid-JSON orphan tails", async () => {
	const source = await fixture();
	await source.save(`repo:${repository}:actions`, { runs: [], unavailable: true, forbidden: true });
	await source.save(`repo:${repository}:releases`, { releases: [], freshness: "unknown" });
	await source.raw
		.prepare(
			'INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,\'not-json\',?,\'{"hash":"h","fullVersion":"v"}\')',
		)
		.bind(account, `repo:${repository}:orphan:actions#2`, at)
		.run();
	let read = await source.read();
	expect(JSON.stringify(read.result)).toBe(JSON.stringify(await source.expected()));
	expect(
		JSON.parse(read.rows.find((row) => row.kind.endsWith(":actions"))?.payload ?? "{}").runs,
	).toEqual([]);
	expect(
		JSON.parse(read.rows.find((row) => row.kind.endsWith(":releases"))?.payload ?? "{}").releases,
	).toEqual([]);
	expect(read.rows.find((row) => row.kind.endsWith("actions#2"))?.payload).toBe("not-json");
	await source.save(`repo:${repository}:actions`, { runs: [null, "not-a-run"], unavailable: true });
	await source.save(`repo:${repository}:releases`, { releases: null });
	read = await source.read();
	expect(JSON.stringify(read.result)).toBe(JSON.stringify(await source.expected()));
	expect(
		JSON.parse(read.rows.find((row) => row.kind.endsWith(":actions"))?.payload ?? "{}").runs,
	).toEqual([null, "not-a-run"]);
	expect(
		JSON.parse(read.rows.find((row) => row.kind.endsWith(":releases"))?.payload ?? "{}").releases,
	).toBeNull();
});
