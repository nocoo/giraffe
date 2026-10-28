import { expect, it } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import {
	collectLandedPage,
	readLandedActivity,
	supplementLandedFromFactoryCommits,
} from "./activity-landed";
import { createDb } from "./db/d1";
import { claimRun, getRun, type RunLease, saveRun, startRun } from "./db/factory-runs";
import { newFactory } from "./factory-collect";
import { mapFactoryRepo } from "./factory-map";
import { recordFactoryRate } from "./factory-rate";

const first = "2026-10-22T22:14:55.000Z";
const second = "2026-10-23T22:14:55.000Z";
const commit = (sha: string) => ({
	sha,
	commit: { message: `Old work ${sha}`, committer: { date: "2026-10-22T21:50:00.000Z" } },
	author: { login: "nocoo" },
	html_url: `https://github.com/nocoo/app/commit/${sha}`,
});
async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw, undefined, 10_000);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account_123','nocoo','fake','fake',?,?)",
		)
		.bind(first, first)
		.run();
	const repo = mapFactoryRepo(rawRepo);
	async function start(id: string, at: string, head: string | null) {
		await db.prepare("UPDATE factory_runs SET status='cancelled' WHERE status='running'").run();
		const run = makeRun(
			id,
			"account_123",
			"nocoo",
			id,
			"refresh",
			[repo],
			at,
			[],
			[repo.name],
			{ scope: "all" },
			"quick",
		);
		await startRun(db, run);
		const lease = await claimRun(db, id, at);
		if (!lease) throw new Error("fixture lease missing");
		const metadata = lease.run.steps.find((step) => step.kind === "metadata");
		if (!metadata) throw new Error("fixture metadata missing");
		metadata.status = "success";
		metadata.sourceBranch = "main";
		metadata.sourceHead = head;
		return lease;
	}
	async function accept(
		lease: RunLease,
		gh: ReturnType<typeof github>,
		at: string,
		token = "fake",
	) {
		const result = await collectLandedPage(
			db,
			lease,
			repo,
			gh,
			token,
			() => at,
			async () => {},
		);
		expect(await saveRun(db, lease, result.writes, at, true)).toBe(true);
		return result;
	}
	return { raw, db, repo, start, accept };
}

it("attributes eagle/steed old-dated commits to their first observed window, never their dates", async () => {
	const fixture = await setup();
	const firstLease = await fixture.start("window-n", first, "base");
	const initial = github(() => Response.json([commit("base")]));
	expect((await fixture.accept(firstLease, initial, first)).done).toBe(false);
	expect(initial.count).toBe(0);
	expect((await fixture.accept(firstLease, initial, first)).done).toBe(true);
	expect(
		(await readLandedActivity(fixture.db, firstLease.run, fixture.repo)).items.map(
			(item) => item.sha,
		),
	).toEqual(["base"]);
	const nextLease = await fixture.start("window-n1", second, "steed");
	const delta = github((url) => {
		expect(url).toContain("/compare/base...steed?per_page=100&page=1");
		expect(url).not.toContain("since=");
		return Response.json({
			status: "ahead",
			total_commits: 2,
			commits: [commit("eagle"), commit("steed")],
		});
	});
	await fixture.accept(nextLease, delta, second);
	await fixture.accept(nextLease, delta, second);
	const observed = await readLandedActivity(fixture.db, nextLease.run, fixture.repo);
	expect(observed.items.map((item) => item.sha)).toEqual(["eagle", "steed"]);
	expect(observed.items[0]?.observation).toMatchObject({
		runId: "window-n1",
		window: nextLease.run.activityWindow,
		bootstrap: false,
	});
	expect(observed.deferred[0]?.items.map((item) => item.sha)).toEqual(["base"]);
	await fixture.accept(nextLease, delta, second);
	expect(delta.count).toBe(1);
	expect(
		(await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all()).results,
	).toHaveLength(3);
});

it("resumes bootstrap after cancellation with the original window and one page per step", async () => {
	const fixture = await setup();
	const lease = await fixture.start("bootstrap", first, "head");
	const gh = github((url) =>
		Response.json(
			url.includes("page=2")
				? [commit("tail")]
				: Array.from({ length: 100 }, (_, index) => commit(index === 0 ? "head" : `sha-${index}`)),
			{
				headers: url.includes("page=2")
					? {}
					: { link: '<https://api.github.com/repos/nocoo/app/commits?page=2>; rel="next"' },
			},
		),
	);
	await fixture.accept(lease, gh, first);
	expect((await fixture.accept(lease, gh, first)).done).toBe(false);
	expect(gh.count).toBe(1);
	const resumed = await fixture.start("resumed", second, "head");
	expect((await fixture.accept(resumed, gh, second)).done).toBe(true);
	expect(gh.count).toBe(2);
	const result = await readLandedActivity(fixture.db, resumed.run, fixture.repo);
	expect(result.items).toEqual([]);
	expect(result.deferred[0]?.items).toHaveLength(101);
	expect(result.deferred[0]?.runId).toBe("bootstrap");
	expect(result.deferred[0]?.items.every((item) => item.observation?.bootstrap)).toBe(true);
	await fixture.accept(resumed, gh, second);
	expect(gh.count).toBe(2);
});

it("cannot count invisible force-pushed commits and retains observed removed identities", async () => {
	const fixture = await setup();
	const lease = await fixture.start("observed", first, "visible");
	const initial = github(() => Response.json([commit("visible")]));
	await fixture.accept(lease, initial, first);
	await fixture.accept(lease, initial, first);
	const next = await fixture.start("rewritten", second, "replacement");
	const gh = github((url) =>
		Response.json(
			url.includes("/compare/")
				? { status: "diverged", total_commits: 1, commits: [commit("replacement")] }
				: [commit("replacement")],
		),
	);
	await fixture.accept(next, gh, second);
	expect((await fixture.accept(next, gh, second)).done).toBe(false);
	await fixture.accept(next, gh, second);
	expect(
		(await fixture.db.prepare("SELECT sha FROM activity_commit_ledger ORDER BY sha").all()).results,
	).toEqual([{ sha: "replacement" }, { sha: "visible" }]);
	const restored = await fixture.start("restored", "2026-10-24T22:14:55.000Z", "visible");
	await fixture.accept(restored, initial, restored.run.startedAt);
	const restore = github(() =>
		Response.json({ status: "ahead", total_commits: 1, commits: [commit("visible")] }),
	);
	await fixture.accept(restored, restore, restored.run.startedAt);
	expect(
		await fixture.db
			.prepare("SELECT first_run_id FROM activity_commit_ledger WHERE sha='visible'")
			.first(),
	).toEqual({ first_run_id: "observed" });
});

it("rejects an expired page atomically and renews after a response before checkpoint processing", async () => {
	const fixture = await setup();
	const lease = await fixture.start("fenced", first, "head");
	const gh = github(() => Response.json([commit("head")]));
	await fixture.accept(lease, gh, first);
	let heartbeats = 0;
	const result = await collectLandedPage(
		fixture.db,
		lease,
		fixture.repo,
		gh,
		"fake",
		() => first,
		async () => {
			heartbeats++;
		},
	);
	expect(heartbeats).toBe(1);
	await fixture.db
		.prepare("UPDATE factory_runs SET lease_until=? WHERE id=?")
		.bind(first, lease.run.id)
		.run();
	expect(await saveRun(fixture.db, lease, result.writes, first, true)).toBe(false);
	expect((await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all()).results).toEqual(
		[],
	);
	expect(
		JSON.parse(
			(
				await fixture.db
					.prepare("SELECT pending FROM activity_commit_heads")
					.first<{ pending: string }>()
			)?.pending ?? "null",
		).page,
	).toBe(1);
});

it("fails closed at account capacity without advancing the accepted cursor", async () => {
	const fixture = await setup();
	const lease = await fixture.start("capacity", first, "head");
	const gh = github(() => Response.json([commit("head")]));
	await fixture.accept(lease, gh, first);
	await fixture.db
		.prepare(
			"INSERT INTO factory_budget(account_id,bytes) VALUES('account_123',512000000) ON CONFLICT(account_id) DO UPDATE SET bytes=512000000",
		)
		.run();
	await expect(fixture.accept(lease, gh, first)).rejects.toMatchObject({
		code: "factory_capacity",
	});
	expect((await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all()).results).toEqual(
		[],
	);
});

it("rejects empty or malformed pinned histories instead of publishing a successful zero", async () => {
	for (const rows of [
		[],
		[commit("not-the-head")],
		[commit("head"), commit("head")],
		[{ sha: "head" }],
		{ message: "not history" },
	]) {
		const fixture = await setup();
		const lease = await fixture.start("invalid-history", first, "head");
		const gh = github(() => Response.json(rows));
		await fixture.accept(lease, gh, first);
		await expect(fixture.accept(lease, gh, first)).rejects.toMatchObject({
			code: "snapshot_incomplete",
		});
		expect(
			(await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all()).results,
		).toEqual([]);
	}
});

it.each([404, 422])(
	"falls back from unavailable comparison (%s) without accepting its body",
	async (status) => {
		const fixture = await setup();
		const lease = await fixture.start("fallback", first, "head");
		await fixture.db
			.prepare(
				"INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES('account_123',?,'lost-base')",
			)
			.bind(fixture.repo.id)
			.run();
		const gh = github((url) =>
			url.includes("/compare/")
				? Response.json({ message: "Not Found" }, { status })
				: Response.json([commit("head")]),
		);
		await fixture.accept(lease, gh, first);
		expect((await fixture.accept(lease, gh, first)).done).toBe(false);
		expect((await fixture.accept(lease, gh, first)).done).toBe(true);
		expect(gh.count).toBe(2);
	},
);

it.each(
	([404, 502, "diverged", "behind"] as const).flatMap((failure) =>
		[false, true].map((resume) => ({ failure, resume })),
	),
)(
	"restarts the scan after $failure with accepted compare pages (resume=$resume)",
	async ({ failure, resume }) => {
		const fixture = await setup();
		const original = await fixture.start("compare-round", first, "head");
		await fixture.db
			.prepare(
				"INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES('account_123',?,'base')",
			)
			.bind(fixture.repo.id)
			.run();
		const gh = github((url) => {
			if (url.includes("/compare/")) {
				if (url.includes("page=2"))
					return typeof failure === "number"
						? Response.json({ message: "Unavailable" }, { status: failure })
						: Response.json({ status: failure, commits: [], total_commits: 0 });
				return Response.json(
					{ status: "ahead", total_commits: 2, commits: [commit("observed")] },
					{
						headers: {
							link: '<https://api.github.com/repos/nocoo/app/compare/base...head?page=2>; rel="next"',
						},
					},
				);
			}
			return url.includes("page=2")
				? Response.json([commit("base")])
				: Response.json([commit("head"), commit("observed")], {
						headers: {
							link: '<https://api.github.com/repos/nocoo/app/commits?page=2>; rel="next"',
						},
					});
		});
		await fixture.accept(original, gh, first);
		expect((await fixture.accept(original, gh, first)).done).toBe(false);
		const evidence = () =>
			fixture.db
				.prepare(
					"SELECT first_run_id,observed_at,window_since,window_until,payload,published_run_id FROM activity_commit_ledger WHERE sha='observed'",
				)
				.first();
		const accepted = await evidence();
		expect((await fixture.accept(original, gh, first)).done).toBe(false);
		const lease = resume ? await fixture.start("history-resume", second, "head") : original;
		const now = resume ? second : first;
		expect((await fixture.accept(lease, gh, now)).done).toBe(false);
		expect(await evidence()).toEqual(accepted);
		await expect(
			fixture.accept(
				lease,
				github(() => Response.json([commit("observed")])),
				now,
			),
		).rejects.toMatchObject({ code: "snapshot_incomplete" });
		expect(await fixture.db.prepare("SELECT head FROM activity_commit_heads").first()).toEqual({
			head: "base",
		});
		expect((await fixture.accept(lease, gh, now)).done).toBe(true);
		expect(
			await fixture.db.prepare("SELECT head,pending FROM activity_commit_heads").first(),
		).toEqual({
			head: "head",
			pending: null,
		});
		expect(await evidence()).toEqual(accepted);
		const result = await readLandedActivity(fixture.db, lease.run, fixture.repo);
		const items = resume ? result.deferred[0]?.items : result.items;
		expect(items?.map((item) => item.sha)).toEqual(["base", "head", "observed"]);
		expect(items?.every((item) => item.observation?.runId === original.run.id)).toBe(true);
		if (resume) expect(result.items).toEqual([]);
		await fixture.accept(lease, gh, now);
		expect(gh.count).toBe(4);
	},
);

it("checks capacity inside the acceptance transaction, not just before another lane saves", async () => {
	const fixture = await setup();
	const lease = await fixture.start("quota-race", first, "head");
	const gh = github(() => Response.json([commit("head")]));
	await fixture.accept(lease, gh, first);
	const result = await collectLandedPage(
		fixture.db,
		lease,
		fixture.repo,
		gh,
		"fake",
		() => first,
		async () => {},
	);
	await fixture.db
		.prepare(
			"INSERT INTO factory_budget(account_id,bytes) VALUES('account_123',512000000) ON CONFLICT(account_id) DO UPDATE SET bytes=512000000",
		)
		.run();
	await expect(saveRun(fixture.db, lease, result.writes, first, true)).rejects.toMatchObject({
		code: "db_error",
	});
	expect((await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all()).results).toEqual(
		[],
	);
	expect(await fixture.db.prepare("SELECT head FROM activity_commit_heads").first()).toEqual({
		head: null,
	});
});

it("does not expose another repository identity's pending ledger without successful current metadata", async () => {
	const fixture = await setup();
	const lease = await fixture.start("identity", first, "head");
	const gh = github(() => Response.json([commit("head")]));
	await fixture.accept(lease, gh, first);
	await fixture.accept(lease, gh, first);
	lease.run.repoIds[fixture.repo.name] = "different-id";
	const result = await readLandedActivity(fixture.db, lease.run, fixture.repo);
	expect(result.items).toEqual([]);
	expect(result.coverage.status).toBe("unavailable");
});

it("follows a short history page's explicit next link without advancing the complete head", async () => {
	const fixture = await setup();
	const lease = await fixture.start("short-page", first, "head");
	const gh = github((url) =>
		url.includes("page=2")
			? Response.json([commit("tail")])
			: Response.json([commit("head")], {
					headers: { link: '<https://api.github.com/repos/nocoo/app/commits?page=2>; rel="next"' },
				}),
	);
	await fixture.accept(lease, gh, first);
	expect((await fixture.accept(lease, gh, first)).done).toBe(false);
	expect(await fixture.db.prepare("SELECT head FROM activity_commit_heads").first()).toEqual({
		head: null,
	});
	expect((await fixture.accept(lease, gh, first)).done).toBe(true);
	expect(
		await fixture.db.prepare("SELECT COUNT(*) AS count FROM activity_commit_ledger").first(),
	).toEqual({ count: 2 });
});

it("rejects duplicate SHAs across compare pages instead of mistaking row count for unique coverage", async () => {
	const fixture = await setup();
	const lease = await fixture.start("repeat-page", first, "head");
	await fixture.db
		.prepare(
			"INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES('account_123',?,'base')",
		)
		.bind(fixture.repo.id)
		.run();
	const gh = github(() =>
		Response.json({
			status: "ahead",
			total_commits: 200,
			commits: Array.from({ length: 100 }, (_, index) => commit(`sha-${index}`)),
		}),
	);
	await fixture.accept(lease, gh, first);
	await fixture.accept(lease, gh, first);
	await expect(fixture.accept(lease, gh, first)).rejects.toMatchObject({
		code: "snapshot_incomplete",
	});
	expect(await fixture.db.prepare("SELECT head FROM activity_commit_heads").first()).toEqual({
		head: "base",
	});
});

it.each(
	(["history", "compare", "diverged"] as const).flatMap((mode) =>
		["message", "message-tail", "author", "url", "sha", "ignored"].map((field) => ({
			mode,
			field,
		})),
	),
)("rejects credentials in $field before accepting a $mode response", async ({ mode, field }) => {
	const fixture = await setup();
	const lease = await fixture.start("credential-guard", first, "head");
	const token = "synthetic_pat_for_ledger_regression";
	if (mode !== "history")
		await fixture.db
			.prepare(
				"INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES('account_123',?,'base')",
			)
			.bind(fixture.repo.id)
			.run();
	const echoed = {
		...commit(field === "sha" ? token : "echoed"),
		commit: {
			message:
				field === "message"
					? token
					: field === "message-tail"
						? `Safe subject\n${"x".repeat(250)}${token}`
						: "Safe subject",
			committer: { date: first },
		},
		author: { login: field === "author" ? token : "nocoo" },
		html_url: field === "url" ? `https://example.test/${token}` : "https://example.test/safe",
		diagnostic: field === "ignored" ? token : "safe",
	};
	const response = (items: ReturnType<typeof commit>[]) =>
		Response.json(
			mode === "history"
				? items
				: {
						status: mode === "diverged" ? "diverged" : "ahead",
						total_commits: items.length,
						commits: items,
					},
		);
	const gh = github(() => response([commit("head"), echoed]));
	await fixture.accept(lease, gh, first, token);
	const saved = await fixture.db.prepare("SELECT * FROM activity_commit_heads").all();
	await expect(fixture.accept(lease, gh, first, token)).rejects.toMatchObject({
		code: "snapshot_incomplete",
		message: "Commit source contains credentials",
	});
	expect(await fixture.db.prepare("SELECT * FROM activity_commit_heads").all()).toEqual(saved);
	const ledger = await fixture.db.prepare("SELECT * FROM activity_commit_ledger").all();
	expect(ledger.results).toEqual([]);
	expect(JSON.stringify(ledger)).not.toContain(token);
	const activity = await readLandedActivity(fixture.db, lease.run, fixture.repo);
	expect(activity.items).toEqual([]);
	expect(activity.deferred).toEqual([]);
	expect(JSON.stringify(activity)).not.toContain(token);
	const clean = github(() => response([commit("head")]));
	expect((await fixture.accept(lease, clean, first, token)).done).toBe(mode !== "diverged");
});

it.each(["history", "compare"])(
	"persists successful %s rates and blocks the next request until reset",
	async (mode) => {
		const fixture = await setup();
		const lease = await fixture.start("reserve", first, "head");
		const resetAt = new Date(Date.parse(first) + 3_600_000).toISOString();
		lease.run.checkpoint = newFactory(lease.run.account_id, "nocoo", first);
		recordFactoryRate(lease.run.checkpoint, {
			resource: "graphql",
			remaining: 500,
			resetAt,
			observedAt: first,
		});
		recordFactoryRate(lease.run.checkpoint, {
			resource: "core",
			remaining: 51,
			resetAt,
			observedAt: first,
		});
		if (mode === "compare")
			await fixture.db
				.prepare(
					"INSERT INTO activity_commit_heads(account_id,repo_id,head) VALUES('account_123',?,'base')",
				)
				.bind(fixture.repo.id)
				.run();
		const gh = github((url) => {
			const last = url.includes("page=2");
			const items = [commit(last ? "tail" : "head")];
			return Response.json(
				mode === "history" ? items : { status: "ahead", total_commits: 2, commits: items },
				{
					headers: {
						"x-ratelimit-remaining": last ? "5000" : "49",
						"x-ratelimit-reset": String(Date.parse(resetAt) / 1000 + (last ? 3600 : 0)),
						...(last ? {} : { link: `<${url.replace("&page=1", "&page=2")}>; rel="next"` }),
					},
				},
			);
		});
		await fixture.accept(lease, gh, first);
		expect((await fixture.accept(lease, gh, first)).done).toBe(false);
		const saved = await getRun(fixture.db, lease.run.account_id, lease.run.id);
		expect(saved?.run.checkpoint?.rate).toEqual({
			resource: "core",
			remaining: 49,
			resetAt,
			observedAt: first,
		});
		expect(saved?.run.checkpoint?.rateLimits?.graphql?.remaining).toBe(500);
		expect(
			await fixture.db.prepare("SELECT COUNT(*) AS count FROM activity_commit_ledger").first(),
		).toEqual({ count: 1 });
		const checkpoint = await fixture.db.prepare("SELECT * FROM activity_commit_heads").all();
		await expect(fixture.accept(lease, gh, first)).rejects.toMatchObject({
			code: "github_rate_limited",
			retryAt: resetAt,
		});
		expect(gh.count).toBe(1);
		expect(await fixture.db.prepare("SELECT * FROM activity_commit_heads").all()).toEqual(
			checkpoint,
		);
		const resumed = await fixture.start("reserve-reset", resetAt, "head");
		resumed.run.checkpoint = saved?.run.checkpoint ?? null;
		expect((await fixture.accept(resumed, gh, resetAt)).done).toBe(true);
		expect(gh.count).toBe(2);
		expect(resumed.run.checkpoint?.rate).toMatchObject({
			remaining: 5000,
			resetAt: new Date(Date.parse(resetAt) + 3_600_000).toISOString(),
			observedAt: resetAt,
		});
		expect(
			(await readLandedActivity(fixture.db, resumed.run, fixture.repo)).deferred[0]?.items,
		).toHaveLength(2);
	},
);

it.each([
	{ remaining: null, reset: null, expected: 51 },
	{ remaining: "invalid", reset: null, expected: 51 },
	{ remaining: "-1", reset: null, expected: 51 },
	{ remaining: "1.5", reset: null, expected: 51 },
	{ remaining: "50", reset: null, expected: 50 },
	{ remaining: "49", reset: null, expected: 49 },
	{ remaining: "49", reset: "invalid", expected: 49 },
])(
	"validates remaining=$remaining and reset=$reset without losing a successful page",
	async ({ remaining, reset, expected }) => {
		const fixture = await setup();
		const lease = await fixture.start("rate-headers", first, "head");
		lease.run.checkpoint = newFactory(lease.run.account_id, "nocoo", first);
		recordFactoryRate(lease.run.checkpoint, {
			resource: "core",
			remaining: 51,
			resetAt: second,
			observedAt: first,
		});
		const headers = new Headers();
		if (remaining !== null) headers.set("x-ratelimit-remaining", remaining);
		if (reset !== null) headers.set("x-ratelimit-reset", reset);
		const gh = github(() => Response.json([commit("head")], { headers }));
		await fixture.accept(lease, gh, first);
		expect((await fixture.accept(lease, gh, first)).done).toBe(true);
		expect(lease.run.checkpoint.rate).toEqual({
			resource: "core",
			remaining: expected,
			resetAt: expected === 51 ? second : null,
			observedAt: first,
		});
		expect((await readLandedActivity(fixture.db, lease.run, fixture.repo)).items).toHaveLength(1);
	},
);

it("supplements incomplete landed coverage from complete in-run factory commits", async () => {
	const fixture = await setup();
	const lease = await fixture.start("bind-run", first, "head-sha");
	const landed = await readLandedActivity(fixture.db, lease.run, fixture.repo);
	expect(landed.coverage).toMatchObject({
		status: "unavailable",
		reason: "Pinned default-branch observation incomplete",
	});
	const bound = supplementLandedFromFactoryCommits(
		landed,
		{
			runId: lease.run.id,
			items: [
				{
					id: "factory-sha",
					title: "factory commit",
					at: first,
					url: "https://example/commit",
					author: "nocoo",
					createdAt: first,
					closedAt: null,
					mergedAt: null,
					state: "committed",
				},
			],
			next: null,
			ranges: [],
			coverage: { ...fixture.repo.coverage.commits, status: "complete" },
		},
		lease.run,
		"main",
	);
	expect(bound.coverage).toMatchObject({
		status: "partial",
		truncated: true,
		reason:
			"Pinned default-branch observation incomplete; bound in-run factory default-branch commits",
	});
	expect(bound.items).toMatchObject([{ sha: "factory-sha", is_default_branch: true }]);
});
