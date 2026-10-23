import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { emptyMetrics, mergeMetrics, summarizeEvents } from "../../lib/factory";
import { makeRun } from "../../lib/factory-run";
import {
	FACTORY_STREAMS,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { contentVersion, savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import {
	claimRun,
	controlRun,
	publishedFactory,
	repoStates,
	saveRun,
	startRun,
} from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { currentRepo, publicationWrites, repositoryWrites } from "./factory-publish";
import { pruneFactory } from "./factory-retention";
import { readFactoryResource } from "./machine-observations";
import { readSources } from "./machine-sources";

const now = "2026-10-23T05:00:00.000Z";
const priorAt = "2026-10-18T05:00:00.000Z";
const event = {
	id: "old",
	title: "old",
	url: "https://github.example/old",
	at: "2026-10-17T05:00:00.000Z",
	createdAt: "2026-10-17T05:00:00.000Z",
	closedAt: null,
	mergedAt: "2026-10-17T06:00:00.000Z",
	author: "dependabot",
	state: "open",
	conclusion: "success",
	version: "v4",
	path: "package.json",
};

async function setup(stream: FactoryStreamName, source: "run" | "legacy" = "run") {
	const raw = sqliteFixture();
	const db = createDb(raw);
	const snapshot = factoryFixture();
	const account = snapshot.account_id;
	const previous = snapshot.repos[0];
	if (!previous) throw new Error("Missing fixture");
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'nocoo','fake','fake',?,?)",
		)
		.bind(account, now, now)
		.run();
	await startRun(db, makeRun("current", account, "nocoo", "current", "refresh", [previous], now));
	const lease = await claimRun(db, "current", now);
	if (!lease) throw new Error("Missing lease");
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('previous',?,'previous','completed','{}',?,?,?)",
		)
		.bind(account, priorAt, priorAt, priorAt)
		.run();
	previous.observation = {
		version: "previous",
		source,
		refreshedAt: priorAt,
		publishedAt: priorAt,
		window: { since: "2026-07-20T00:00:00.000Z", until: priorAt },
	};
	for (const name of FACTORY_STREAMS)
		previous.coverage[name] = {
			...previous.coverage[name],
			status: "complete",
			observed: 1,
			fetchedAt: priorAt,
		};
	if (stream === "dependencies")
		Object.assign(previous.coverage.dependencies, {
			status: "limited",
			reason_code: "dependency_parse_unsupported",
			reason: "Unsupported workflow",
			observed: 0,
		});
	previous.metrics = mergeMetrics(
		FACTORY_STREAMS.map((name) =>
			summarizeEvents(name, [event], previous.observation?.window ?? snapshot.window),
		),
	);
	previous.dependencies = [{ name: "old", version: "v4", path: "package.json", url: event.url }];
	previous.manifests = [
		{ name: "package.json", version: "", path: "package.json", url: event.url },
	];
	await db.batch(await repositoryWrites(db, lease, now, previous, previous.name, null, true));
	const evidence: FactoryStreamData = {
		runId: "previous",
		items: [event],
		next: null,
		ranges: [previous.observation.window],
		coverage: previous.coverage[stream],
	};
	if (source === "run")
		await db
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('previous',?,?,?,?)",
			)
			.bind(
				previous.name,
				stream,
				JSON.stringify(evidence),
				await savedContentMeta(
					`factory:${previous.name}:${stream}`,
					evidence,
					previous.observation.window,
				),
			)
			.run();
	else
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				`factory:${previous.name}:${stream}`,
				evidence,
				priorAt,
			),
		);
	await db.batch(await replaceSnapshotStmts(db, account, "factory", snapshot, priorAt));
	await db.batch(
		await replaceSnapshotStmts(
			db,
			account,
			"repos",
			{ repos: [{ name_with_owner: previous.name }] },
			priorAt,
		),
	);
	const candidate = structuredClone(previous);
	candidate.head = "new-head";
	candidate.observation = {
		version: "current",
		source: "run",
		refreshedAt: now,
		window: { since: "2026-07-25T00:00:00.000Z", until: now },
	};
	candidate.metrics = mergeMetrics(
		FACTORY_STREAMS.map((name) =>
			summarizeEvents(
				name,
				[{ ...event, id: "new", at: now, createdAt: now, mergedAt: null }],
				candidate.observation?.window ?? snapshot.window,
			),
		),
	);
	for (const name of FACTORY_STREAMS) {
		candidate.coverage[name].fetchedAt = now;
		const current: FactoryStreamData = {
			runId: "current",
			items: [],
			next: null,
			ranges: [candidate.observation.window],
			coverage: candidate.coverage[name],
		};
		await db
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('current',?,?,?,?)",
			)
			.bind(
				previous.name,
				name,
				JSON.stringify(current),
				await savedContentMeta(
					`factory:${previous.name}:${name}`,
					current,
					candidate.observation.window,
				),
			)
			.run();
	}
	if (stream !== "dependencies") candidate.coverage[stream].status = "unavailable";
	return { raw, db, account, lease, previous, candidate, evidence };
}

it.each(FACTORY_STREAMS)(
	"retains only regressed %s evidence, not current streams",
	async (stream) => {
		const { raw, db, account, lease, previous, candidate, evidence } = await setup(stream);
		const before = structuredClone(candidate);
		await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
		expect(candidate).toEqual(before);
		const accepted = await currentRepo(db, account, candidate.name);
		expect(accepted?.observation).toEqual(candidate.observation);
		expect(accepted?.coverage[stream]).toMatchObject({
			...previous.coverage[stream],
			retained: true,
			observation: { ...previous.observation, head: previous.head },
		});
		for (const name of FACTORY_STREAMS.filter((name) => name !== stream))
			expect(accepted?.coverage[name]).toEqual(candidate.coverage[name]);
		const retained = await db
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id='current' AND repo=? AND stream=?",
			)
			.bind(candidate.name, `retained:${stream}`)
			.first<{ payload: string }>();
		expect(JSON.parse(retained?.payload ?? "null")).toEqual(evidence);
		expect(
			JSON.parse(
				(
					await db
						.prepare(
							"SELECT payload FROM factory_resources WHERE run_id='current' AND repo=? AND stream=?",
						)
						.bind(candidate.name, stream)
						.first<{ payload: string }>()
				)?.payload ?? "null",
			),
		).toMatchObject({ runId: "current", items: [] });
		expect((await repoStates(db, account))[0]).toMatchObject({
			version: "current",
			status: "partial",
			error: "coverage_regression_retained",
		});
		await db.batch(await publicationWrites(db, lease, now));
		expect((await publishedFactory(db, account))?.publication?.mixed).toBe(true);
		const sources = await readSources(db, account, {});
		for (const name of FACTORY_STREAMS) {
			const row = sources.sources.find(
				(row) => row.resource === `factory:${candidate.name}:${name}`,
			);
			expect(row).toMatchObject({
				runId: name === stream ? "previous" : "current",
				observedAt: name === stream ? priorAt : now,
			});
			const read = await readFactoryResource(createDb(raw), account, candidate.name, name);
			expect(read.contentVersion).toEqual(row?.contentVersion);
			expect(read.contentVersion).toMatch(/^sha256:/);
			if (name === stream)
				expect(read.data).toMatchObject({
					runId: "previous",
					items: [{ ...event, state: stream === "prs" ? "merged" : event.state }],
					ranges: [previous.observation?.window],
					coverage: { retained: true, fetchedAt: priorAt },
				});
		}
		const recent = await readSources(createDb(raw), account, { since: "2026-10-20T00:00:00Z" });
		expect(
			recent.sources.some((row) => row.resource === `factory:${candidate.name}:${stream}`),
		).toBe(false);
	},
);

it("carries legacy stream evidence without inventing a current observation", async () => {
	const { db, account, lease, candidate } = await setup("dependencies", "legacy");
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	expect(await readFactoryResource(db, account, candidate.name, "dependencies")).toMatchObject({
		sourceVersion: "previous",
		data: { items: [event], coverage: { retained: true } },
	});
});

it("preserves retained stream metrics and original provenance across repeated retention", async () => {
	const { db, account, lease, previous, candidate } = await setup("prs");
	previous.head = null;
	await db
		.prepare("UPDATE factory_repo_versions SET payload=? WHERE version='previous'")
		.bind(JSON.stringify(previous))
		.run();
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
	const accepted = await currentRepo(db, account, candidate.name);
	if (!accepted) throw new Error("Missing accepted repo");
	expect(accepted.metrics).toMatchObject({
		prMerged: previous.metrics.prMerged,
		cycleHours: previous.metrics.cycleHours,
		commits: candidate.metrics.commits,
		days: { "2026-10-17": { prMerged: 1, commits: 0 } },
	});
	const repeat = structuredClone(candidate);
	repeat.observation = {
		...candidate.observation,
		version: "next",
		refreshedAt: now,
		window: candidate.observation?.window ?? previous.observation?.window,
		source: "run",
	} as NonNullable<typeof candidate.observation>;
	await db
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('next',?,'next','completed','{}',?,?,?)",
		)
		.bind(account, now, now, now)
		.run();
	await db.batch(await repositoryWrites(db, lease, now, repeat, repeat.name, null));
	const next = await currentRepo(db, account, repeat.name);
	expect(next?.coverage.prs).toEqual(accepted.coverage.prs);
	expect(next?.coverage.prs.observation?.head).toBeNull();
	expect(next?.metrics).toEqual(accepted.metrics);
	const saved = await db
		.prepare("SELECT payload FROM factory_resources WHERE run_id='next' AND stream='retained:prs'")
		.first<{ payload: string }>();
	expect(JSON.parse(saved?.payload ?? "null")).toMatchObject({ runId: "previous", items: [event] });
	expect(await contentVersion("factory", { repos: [accepted] })).toBe(
		await contentVersion("factory", { repos: [next] }),
	);
});

it.each(["missing", "mismatched"])(
	"keeps %s retained evidence unavailable instead of using current data",
	async (mode) => {
		const { raw, db, account, lease, candidate } = await setup("dependencies");
		if (mode === "missing")
			await db.prepare("DELETE FROM factory_resources WHERE run_id='previous'").run();
		else
			await db
				.prepare(
					"UPDATE factory_resources SET payload=json_set(payload,'$.runId','wrong') WHERE run_id='previous'",
				)
				.run();
		await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
		await db.batch(await publicationWrites(db, lease, now));
		await expect(
			readFactoryResource(createDb(raw), account, candidate.name, "dependencies"),
		).rejects.toMatchObject({ code: "snapshot_missing" });
		const sources = await readSources(createDb(raw), account, {});
		expect(
			sources.sources.find((row) => row.resource === `factory:${candidate.name}:dependencies`),
		).toMatchObject({
			runId: "previous",
			observedAt: priorAt,
			contentVersion: null,
			unavailable: true,
			coverage: { status: "unavailable", retained: true },
		});
		expect(
			sources.sources.find((row) => row.resource === `factory:${candidate.name}:commits`),
		).toMatchObject({ runId: "current", observedAt: now });
	},
);

it("fences retained evidence copies together with the new repository version", async () => {
	const { db, account, lease, candidate } = await setup("dependencies");
	const writes = await repositoryWrites(db, lease, now, candidate, candidate.name, null);
	await controlRun(db, account, lease.run.id, "pause", now);
	expect(await saveRun(db, lease, writes, now)).toBe(false);
	expect((await currentRepo(db, account, candidate.name))?.observation?.version).toBe("previous");
	expect(
		await db
			.prepare("SELECT payload FROM factory_resources WHERE stream='retained:dependencies'")
			.first(),
	).toBeNull();
});

it("freezes the original publication time from repository state, not immutable version payload", async () => {
	const { raw, db, account, lease, previous, candidate } = await setup("dependencies");
	await db
		.prepare(
			"UPDATE factory_repo_versions SET payload=json_remove(payload,'$.observation.publishedAt') WHERE version='previous'",
		)
		.run();
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
	expect(
		(await currentRepo(db, account, candidate.name))?.coverage.dependencies.observation
			?.publishedAt,
	).toBe(previous.observation?.publishedAt);
	await db.batch(await publicationWrites(db, lease, now));
	const indexed = (await readSources(createDb(raw), account, {})).sources.find(
		(row) => row.resource === `factory:${candidate.name}:dependencies`,
	);
	expect(indexed).toMatchObject({ observedAt: priorAt, fetchedAt: priorAt });
	expect(
		(await readFactoryResource(createDb(raw), account, candidate.name, "dependencies")).data
			.observation,
	).toMatchObject({ publishedAt: priorAt });
});

it("retains shrinking limited evidence and preserves the error path", async () => {
	const { db, account, lease, previous, candidate } = await setup("issues");
	previous.coverage.issues.status = "limited";
	previous.coverage.issues.observed = 10;
	await db
		.prepare("UPDATE factory_repo_versions SET payload=? WHERE version='previous'")
		.bind(JSON.stringify(previous))
		.run();
	candidate.coverage.issues.status = "limited";
	candidate.coverage.issues.observed = 2;
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
	const accepted = await currentRepo(db, account, candidate.name);
	expect(accepted?.coverage.issues).toMatchObject({ retained: true, observed: 10 });
	candidate.metrics = emptyMetrics();
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, "github_error"));
	expect(await currentRepo(db, account, candidate.name)).toEqual(accepted);
	expect((await repoStates(db, account))[0]).toMatchObject({
		status: "failed",
		error: "github_error",
		version: "current",
	});
});

it("keeps copied retained evidence readable after pruning its original run", async () => {
	const { raw, db, account, lease, candidate } = await setup("dependencies");
	await db.batch(await repositoryWrites(db, lease, now, candidate, candidate.name, null));
	await db.batch(await publicationWrites(db, lease, now));
	await db
		.prepare("UPDATE factory_runs SET created_at='2000-01-01T00:00:00Z' WHERE id='previous'")
		.run();
	await db
		.prepare(
			"UPDATE factory_repo_versions SET refreshed_at='2000-01-01T00:00:00Z' WHERE version='previous'",
		)
		.run();
	for (let index = 0; index < 21; index++)
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed','{}',?,?,?)",
			)
			.bind(`filler-${index}`, account, `filler-${index}`, now, now, now)
			.run();
	await pruneFactory(createDb(raw), now);
	expect(
		await createDb(raw).prepare("SELECT id FROM factory_runs WHERE id='previous'").first(),
	).toBeNull();
	expect(
		await readFactoryResource(createDb(raw), account, candidate.name, "dependencies"),
	).toMatchObject({
		sourceVersion: "previous",
		data: { items: [event], coverage: { retained: true } },
	});
});
