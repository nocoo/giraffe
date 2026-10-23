import { afterEach, expect, it, vi } from "vitest";
import { rawEvent, rawRepo } from "../../../../../tests/fixtures/factory";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun, RUN_LEASE_MS } from "../../lib/factory-run";
import {
	FACTORY_STREAMS,
	type FactorySnapshot,
	type FactoryStreamData,
} from "../../lib/factory-types";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { claimRun, getRun, publishedFactory, startRun } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { executeRunPage } from "./factory-execute";
import { FactoryInvocation, INVOCATION_REQUESTS } from "./factory-invocation";
import { mapFactoryEvents } from "./factory-map";
import { executeRepoPool } from "./factory-pool";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const LEGACY_REPO = "nocoo/app0";
const NEXT_REPO = "nocoo/app1";

async function setup(stream: "issues" | "prs" = "issues") {
	const snapshot = factoryFixture();
	const first = snapshot.repos[0];
	if (!first) throw new Error("fixture repository missing");
	const repos = [LEGACY_REPO, NEXT_REPO].map((name, index) => ({
		...structuredClone(first),
		id: `repo-${index}`,
		name,
	}));
	const now = snapshot.fetched_at;
	const env = {
		DB: sqliteFixture(),
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
		TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
	} as unknown as Env;
	const db = createDb(env.DB);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at,capabilities) VALUES(?,?,?,?,?,?,?)",
		)
		.bind(
			snapshot.account_id,
			"nocoo",
			await encryptToken("fake", parseKeyBytes("0".repeat(64))),
			"fake",
			now,
			now,
			JSON.stringify({ repo: true, notifications: true }),
		)
		.run();
	await db.batch(
		await replaceSnapshotStmts(db, snapshot.account_id, "factory", { ...snapshot, repos }, now),
	);
	await db.batch(
		await replaceSnapshotStmts(
			db,
			snapshot.account_id,
			"repos",
			{ repos: repos.map((repo) => ({ name_with_owner: repo.name })) },
			now,
		),
	);
	const run = makeRun(
		"upgrade-pool",
		snapshot.account_id,
		"nocoo",
		"upgrade",
		"refresh",
		repos,
		now,
		[],
		[LEGACY_REPO, NEXT_REPO],
		{ scope: "selected", repos: [LEGACY_REPO, NEXT_REPO] },
	);
	run.window = snapshot.window;
	run.cursor = run.steps.findIndex((step) => step.repo === LEGACY_REPO && step.kind === stream);
	for (const step of run.steps.slice(0, run.cursor)) {
		step.status = "success";
		step.attempts = 1;
		step.startedAt = now;
		step.finishedAt = now;
	}
	const current = run.steps[run.cursor];
	if (!current || !repos[0]) throw new Error("fixture step missing");
	current.status = "running";
	current.pages = 1;
	current.attempts = 1;
	current.startedAt = now;
	const checkpoint: FactorySnapshot = {
		...structuredClone(snapshot),
		runId: run.id,
		repos: [structuredClone(repos[0])],
		cursor: { repo: 0, stream: FACTORY_STREAMS.indexOf(stream) },
		contributionStatus: "complete",
	};
	const repo = checkpoint.repos[0];
	if (!repo) throw new Error("fixture checkpoint missing");
	const path = `/repos/${LEGACY_REPO}/${stream === "prs" ? "pulls" : "issues"}`;
	const source = `${path}?state=all&sort=updated&direction=desc&per_page=100&page=1`;
	const accepted: FactoryStreamData = {
		runId: run.id,
		items: mapFactoryEvents(stream, [rawEvent(1)]).map(
			({ updatedAt: _updatedAt, ...item }) => item,
		),
		next: source.replace("&page=1", "&page=2"),
		ranges: [],
		coverage: {
			...repo.coverage[stream],
			status: "partial",
			source,
			pages: 1,
			observed: 1,
			fetchedAt: now,
		},
	};
	repo.coverage[stream] = structuredClone(accepted.coverage);
	for (const earlier of FACTORY_STREAMS.slice(0, checkpoint.cursor.stream)) {
		repo.coverage[earlier].status = "complete";
	}
	run.checkpoint = checkpoint;
	await startRun(db, run);
	for (const earlier of FACTORY_STREAMS.slice(0, checkpoint.cursor.stream)) {
		await db
			.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
			.bind(
				run.id,
				LEGACY_REPO,
				earlier,
				JSON.stringify({ ...accepted, items: [], next: null, coverage: repo.coverage[earlier] }),
			)
			.run();
	}
	await db
		.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
		.bind(run.id, LEGACY_REPO, stream, JSON.stringify(accepted))
		.run();
	const paths: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);
			paths.push(`${url.pathname}${url.search}`);
			if (url.pathname === path) {
				const page = Number(url.searchParams.get("page"));
				url.host = "api.github.com";
				url.protocol = "https:";
				url.searchParams.set("page", String(page + 1));
				return Response.json([rawEvent(page)], {
					headers: page === 2 ? { link: `<${url}>; rel="next"` } : {},
				});
			}
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			const query = String(body.query);
			if (query.includes("search(query"))
				return Response.json({
					data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
				});
			if (query.includes("nameWithOwner")) {
				const name = String(body.variables.name);
				return Response.json({
					data: {
						repository: {
							...rawRepo,
							id: `repo-${name.slice(-1)}`,
							nameWithOwner: `nocoo/${name}`,
						},
					},
				});
			}
			if (query.includes("object(expression")) return Response.json({ data: { repository: {} } });
			if (query.includes("vulnerabilityAlerts"))
				return Response.json({
					data: {
						repository: { vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } } },
					},
				});
			if (query.includes("nodes(ids:"))
				return Response.json({ data: { nodes: body.variables.ids.map((id: string) => ({ id })) } });
			return Response.json(
				input.includes("actions/runs") ? { total_count: 0, workflow_runs: [] } : [],
			);
		}),
	);
	async function resource<T>(name: string, kind: string): Promise<T | null> {
		const row = await createDb(env.DB)
			.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
			.bind(run.id, name, kind)
			.first<{ payload: string }>();
		return row ? (JSON.parse(row.payload) as T) : null;
	}
	const read = async () => {
		const saved = await getRun(createDb(env.DB), run.account_id, run.id);
		if (!saved) throw new Error("fixture run missing");
		return saved.run;
	};
	async function finish(notBefore = now) {
		let current = await read();
		for (let attempt = 0; current.status === "running" && attempt < 40; attempt++) {
			const time = current.nextAttemptAt > notBefore ? current.nextAttemptAt : notBefore;
			await executeRunPage(env, run.id, () => time);
			current = await read();
		}
		expect(current.status).toBe("completed");
		expect(current.steps.filter((step) => step.status !== "success")).toEqual([]);
		expect(current.steps.slice(0, run.cursor)).toEqual(run.steps.slice(0, run.cursor));
		const executor = await resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint");
		expect(executor?.repos[0]?.name).toBe(LEGACY_REPO);
		expect(executor?.cursor).toEqual({ repo: 1, stream: 0 });
		const data = await resource<FactoryStreamData>(LEGACY_REPO, stream);
		expect(data?.items[0]).toEqual(accepted.items[0]);
		expect(data?.items.map((item) => item.id)).toEqual(["N_1", "N_2", "N_3"]);
		expect(data?.coverage).toMatchObject({ status: "complete", pages: 3, observed: 3, source });
		expect(paths.filter((value) => value.startsWith(`${path}?`))).toEqual([
			accepted.next,
			source.replace("&page=1", "&page=3"),
		]);
		const published = await publishedFactory(createDb(env.DB), run.account_id);
		expect(published?.repos.map((repo) => repo.name).sort()).toEqual([LEGACY_REPO, NEXT_REPO]);
		expect(
			published?.repos.find((repo) => repo.name === LEGACY_REPO)?.coverage[stream],
		).toMatchObject({
			status: "complete",
			observed: 3,
		});
	}
	return { env, run, now, accepted, checkpoint, paths, resource, read, finish };
}

function delayOldCheckpoint(
	fixture: Awaited<ReturnType<typeof setup>>,
	stopAfterSave = false,
	afterSave?: () => void,
) {
	const raw = fixture.env.DB;
	const prepare = raw.prepare.bind(raw);
	let release = () => {};
	const savedB = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(raw, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (sql.includes("SELECT payload") && sql.includes("stream='executor:checkpoint'")) {
			const bind = statement.bind.bind(statement);
			statement.bind = (...args) => {
				const bound = bind(...args);
				if (args[1] === LEGACY_REPO) {
					const first = bound.first.bind(bound);
					bound.first = async <T>() => {
						const result = await first<T>();
						await savedB;
						return result;
					};
				}
				return bound;
			};
		}
		return statement;
	});
	const batch = raw.batch.bind(raw);
	let exhausted = false;
	vi.spyOn(raw, "batch").mockImplementation(async (statements) => {
		const result = await batch(statements);
		const saved = await prepare("SELECT payload FROM factory_runs WHERE id=?")
			.bind(fixture.run.id)
			.first<{ payload: string }>();
		if (saved && JSON.parse(saved.payload).checkpoint?.repos[0]?.name === NEXT_REPO) {
			exhausted = stopAfterSave;
			release();
			afterSave?.();
		}
		return result;
	});
	const endReason = FactoryInvocation.prototype.endReason;
	vi.spyOn(FactoryInvocation.prototype, "endReason").mockImplementation(function (
		this: FactoryInvocation,
		...args
	) {
		if (exhausted) this.requests = INVOCATION_REQUESTS;
		return endReason.apply(this, args);
	});
}

it.each(["issues", "prs"] as const)(
	"keeps legacy %s identity and accepted pages when another lane saves before its read",
	async (stream) => {
		const fixture = await setup(stream);
		delayOldCheckpoint(fixture);
		await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
		vi.restoreAllMocks();
		await fixture.finish();
	},
);

it.each(["issues", "prs"] as const)(
	"durably protects legacy %s before an early budget exit and resumes the old cursor",
	async (stream) => {
		const fixture = await setup(stream);
		delayOldCheckpoint(fixture, true);
		await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
		expect(await fixture.resource<FactoryStreamData>(LEGACY_REPO, stream)).toEqual(
			fixture.accepted,
		);
		const checkpoint = await fixture.resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint");
		expect(checkpoint).toEqual(fixture.checkpoint);
		expect(checkpoint?.repos[0]?.name).toBe(LEGACY_REPO);
		expect(checkpoint?.cursor).toEqual({ repo: 0, stream: FACTORY_STREAMS.indexOf(stream) });
		expect((await fixture.read()).checkpoint?.repos[0]?.name).toBe(NEXT_REPO);
		vi.restoreAllMocks();
		await fixture.finish();
	},
);

it("preserves a newer per-repository checkpoint instead of replacing it with the legacy root", async () => {
	const fixture = await setup();
	const newer = structuredClone(fixture.checkpoint);
	newer.revision = 7;
	await createDb(fixture.env.DB)
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,'executor:checkpoint',?)",
		)
		.bind(fixture.run.id, LEGACY_REPO, JSON.stringify(newer))
		.run();
	delayOldCheckpoint(fixture, true);
	await executeRunPage(fixture.env, fixture.run.id, () => fixture.now);
	expect(await fixture.resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint")).toEqual(
		newer,
	);
	vi.restoreAllMocks();
	await fixture.finish();
	expect(
		(await fixture.resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint"))?.revision,
	).toBeGreaterThanOrEqual(7);
});

it("recovers the protected legacy owner after losing acknowledgement of another lane's commit", async () => {
	const fixture = await setup();
	delayOldCheckpoint(fixture, true, () => {
		throw new Error("fixture commit acknowledgement lost");
	});
	await expect(executeRunPage(fixture.env, fixture.run.id, () => fixture.now)).resolves.toBe(
		new Date(Date.parse(fixture.now) + RUN_LEASE_MS).toISOString(),
	);
	expect(await fixture.resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint")).toEqual(
		fixture.checkpoint,
	);
	expect(await fixture.resource(LEGACY_REPO, "issues")).toEqual(fixture.accepted);
	expect((await fixture.read()).checkpoint?.repos[0]?.name).toBe(NEXT_REPO);
	vi.restoreAllMocks();
	await fixture.finish(new Date(Date.parse(fixture.now) + 60_000).toISOString());
});

async function saveOtherLane(fixture: Awaited<ReturnType<typeof setup>>, loseLease = false) {
	const db = createDb(fixture.env.DB);
	await db
		.prepare("UPDATE factory_runs SET payload=? WHERE id=?")
		.bind(JSON.stringify(fixture.run), fixture.run.id)
		.run();
	const lease = await claimRun(db, fixture.run.id, fixture.now);
	if (!lease) throw new Error("fixture lease missing");
	const index = lease.run.steps.findIndex(
		(step) => step.repo === NEXT_REPO && step.kind === "metadata",
	);
	await executeRepoPool(
		db,
		lease,
		new FactoryInvocation(db, lease, () => fixture.now),
		new Map([[NEXT_REPO, [index]]]),
		async (_db, lane, step, hooks) => {
			expect(await hooks.begin(step)).toBe(true);
			const checkpoint = structuredClone(fixture.checkpoint);
			const repo = checkpoint.repos[0];
			if (!repo) throw new Error("fixture repository missing");
			checkpoint.repos = [{ ...repo, id: "repo-1", name: NEXT_REPO }];
			lane.run.checkpoint = checkpoint;
			step.status = "success";
			if (loseLease)
				await db
					.prepare("UPDATE factory_runs SET lease_token='replacement' WHERE id=?")
					.bind(fixture.run.id)
					.run();
			return { writes: [], stop: false };
		},
		() => {},
		() => {},
	);
}

it("protects the pinned legacy owner after its cursor advanced past the single repository", async () => {
	const fixture = await setup();
	fixture.checkpoint.cursor = { repo: 1, stream: 0 };
	await saveOtherLane(fixture);
	const saved = await fixture.resource<FactorySnapshot>(LEGACY_REPO, "executor:checkpoint");
	expect(saved).toEqual(fixture.checkpoint);
	expect(saved?.repos[0]?.name).toBe(LEGACY_REPO);
	expect(saved?.cursor).toEqual({ repo: 1, stream: 0 });
	expect((await fixture.read()).checkpoint?.repos[0]?.name).toBe(NEXT_REPO);
});

it.each(["multi-repo", "foreign-run", "foreign-repo", "before-metadata"])(
	"does not seed a %s global root as a repository checkpoint",
	async (kind) => {
		const fixture = await setup();
		const root = fixture.checkpoint;
		const repo = root.repos[0];
		if (!repo) throw new Error("fixture root missing");
		if (kind === "multi-repo")
			root.repos.push({ ...structuredClone(repo), id: "repo-1", name: NEXT_REPO });
		if (kind === "foreign-run") root.runId = "different-run";
		if (kind === "foreign-repo") repo.id = "different-repository";
		if (kind === "before-metadata") {
			const metadata = fixture.run.steps.find(
				(step) => step.repo === LEGACY_REPO && step.kind === "metadata",
			);
			if (!metadata) throw new Error("fixture metadata missing");
			metadata.status = "pending";
		}
		await saveOtherLane(fixture);
		expect(await fixture.resource(LEGACY_REPO, "executor:checkpoint")).toBeNull();
	},
);

it.each(["rollback", "lost-lease"])(
	"keeps legacy protection atomic and fenced on %s",
	async (failure) => {
		const fixture = await setup();
		if (failure === "rollback") {
			const batch = fixture.env.DB.batch.bind(fixture.env.DB);
			vi.spyOn(fixture.env.DB, "batch").mockImplementation((statements) =>
				batch([...statements, fixture.env.DB.prepare("SELECT json('{')")]),
			);
		}
		await expect(saveOtherLane(fixture, failure === "lost-lease")).rejects.toMatchObject({
			code: failure === "rollback" ? "db_error" : "factory_lease_lost",
		});
		expect(await fixture.resource(LEGACY_REPO, "executor:checkpoint")).toBeNull();
		expect(await fixture.resource(NEXT_REPO, "executor:checkpoint")).toBeNull();
		expect(await fixture.resource(LEGACY_REPO, "issues")).toEqual(fixture.accepted);
		expect((await fixture.read()).checkpoint).toEqual(fixture.checkpoint);
	},
);
