import { expect, it } from "vitest";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { createDb } from "./db/d1";
import { parseRefreshParams } from "./refresh-params";
import {
	activeRefreshRun,
	addRefreshMetricGuardEvents,
	addRefreshPartialReasons,
	addRefreshRequests,
	cancelRefreshRun,
	closeRefreshStep,
	completeRefreshStepAttempt,
	createRefreshRun,
	emptyRequestBreakdown,
	getRefreshRun,
	listRefreshRuns,
	requestRefreshCancel,
	saveRefreshRun,
	scheduledRefreshRun,
	startRefreshStep,
	terminalRefreshStatus,
} from "./refresh-store";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','octo','fake','fake','t','t'),('other','other','fake','fake','t','t')",
		)
		.run();
	return createDb(raw);
}
it("stores UTC runs, fences accounts, and only permits one active run", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const params = parseRefreshParams({}, new Date(now));
	expect(await activeRefreshRun(db, "account")).toBeNull();
	const run = await createRefreshRun(db, "account", params, "manual", now);
	expect(run.status).toBe("queued");
	expect(await getRefreshRun(db, "other", run.id)).toBeNull();
	expect(await activeRefreshRun(db, "account")).toEqual(run);
	await saveRefreshRun(db, { ...run, status: "running" });
	const queued = await createRefreshRun(db, "account", params, "manual", now);
	await expect(saveRefreshRun(db, { ...queued, status: "running" })).rejects.toThrow();
	await saveRefreshRun(db, { ...queued, status: "failed" });
	await saveRefreshRun(db, { ...run, status: "completed", phase: "done", finishedAt: now });
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect((await listRefreshRuns(db, "account")).find((item) => item.id === run.id)?.status).toBe(
		"completed",
	);
	expect(await listRefreshRuns(db, "other")).toEqual([]);
});
it("deduplicates the Shanghai scheduled day and orders a bounded history", async () => {
	const db = await fixture();
	const now = "2026-10-28T19:00:00.000Z";
	const params = parseRefreshParams({}, new Date(now));
	expect(await scheduledRefreshRun(db, "account", "2026-10-29")).toBeNull();
	const run = await createRefreshRun(db, "account", params, "scheduled", now, "2026-10-29");
	await saveRefreshRun(db, { ...run, status: "failed", errorCode: "github_error" });
	expect(await scheduledRefreshRun(db, "account", "2026-10-29")).toMatchObject({
		id: run.id,
		status: "failed",
	});
	await expect(
		createRefreshRun(db, "account", params, "scheduled", now, "2026-10-29"),
	).rejects.toThrow();
	const next = await createRefreshRun(db, "account", params, "manual", "2026-10-29T02:00:00.000Z");
	expect((await listRefreshRuns(db, "account"))[0]?.id).toBe(next.id);
});
it("initializes the request breakdown, reasons and cancel intent on new runs", async () => {
	const db = await fixture();
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	expect(run).toMatchObject({
		requests: 0,
		requestBreakdown: emptyRequestBreakdown(),
		partialReasons: [],
		cancelRequested: false,
	});
	expect(emptyRequestBreakdown()).toEqual({
		total: 0,
		graphql: 0,
		rest: 0,
		a: { graphql: 0, rest: 0 },
		b: { graphql: 0, rest: 0 },
	});
});
it("accumulates transport counts per phase while keeping the legacy total", async () => {
	const db = await fixture();
	let run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	run = addRefreshRequests(run, "a", { graphql: 2, rest: 1 });
	run = addRefreshRequests(run, "b", { graphql: 1, rest: 2 });
	run = addRefreshRequests(run, "b", { graphql: 0, rest: 4 });
	expect(run.requests).toBe(10);
	expect(run.requestBreakdown).toEqual({
		total: 10,
		graphql: 3,
		rest: 7,
		a: { graphql: 2, rest: 1 },
		b: { graphql: 1, rest: 6 },
	});
});
it("attributes partial reasons to the account or a single repository without duplicates", async () => {
	const db = await fixture();
	let run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	run = addRefreshPartialReasons({ ...run, partial: true }, null, [
		"contributions:unavailable",
		"catalog:incomplete",
	]);
	run = addRefreshPartialReasons(run, "octo/one", ["prs:inventory_incomplete"]);
	run = addRefreshPartialReasons(run, "octo/one", [
		"prs:inventory_incomplete",
		"issues:unavailable",
	]);
	run = addRefreshPartialReasons(run, null, ["catalog:incomplete"]);
	expect(run.partialReasons).toEqual([
		{ repo: null, codes: ["catalog:incomplete", "contributions:unavailable"] },
		{ repo: "octo/one", codes: ["issues:unavailable", "prs:inventory_incomplete"] },
	]);
	expect(addRefreshPartialReasons(run, "octo/two", [])).toBe(run);
});
it("appends metric guard warnings onto the refresh run", async () => {
	const db = await fixture();
	let run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	const event = {
		code: "zero_guard_kept" as const,
		repo: "octo/one",
		day: "2026-10-28",
		field: "commits" as const,
	};
	run = addRefreshMetricGuardEvents(run, [event]);
	expect(run.metricGuardEvents).toEqual([event]);
	expect(addRefreshMetricGuardEvents(run, [])).toBe(run);
	expect(
		addRefreshMetricGuardEvents(run, [{ ...event, field: "prOpened" }]).metricGuardEvents,
	).toEqual([event, { ...event, field: "prOpened" }]);
});
it("marks queued and running runs cancelled once and never mutates terminal runs", async () => {
	const db = await fixture();
	const queued = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date("2026-10-29T01:00:00.000Z")),
		"manual",
		"2026-10-29T01:00:00.000Z",
	);
	const cancelled = cancelRefreshRun(queued, "2026-10-29T01:05:00.000Z");
	expect(cancelled).toMatchObject({
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		updatedAt: "2026-10-29T01:05:00.000Z",
		finishedAt: "2026-10-29T01:05:00.000Z",
	});
	expect(cancelRefreshRun(cancelled, "2026-10-29T02:00:00.000Z")).toBe(cancelled);
	await saveRefreshRun(db, { ...cancelled, status: "cancelled" });
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect((await listRefreshRuns(db, "account"))[0]?.status).toBe("cancelled");
	expect(terminalRefreshStatus("queued")).toBe(false);
	expect(terminalRefreshStatus("running")).toBe(false);
	for (const status of ["completed", "partial", "failed", "cancelled"] as const)
		expect(terminalRefreshStatus(status)).toBe(true);
});
it("persists an external cancellation that stale runner payloads cannot clear", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const running = { ...run, status: "running" as const, phase: "repos" as const };
	await saveRefreshRun(db, running);
	expect(await requestRefreshCancel(db, "account", "missing", now)).toEqual({
		run: null,
		requested: false,
	});
	expect(await requestRefreshCancel(db, "other", run.id, now)).toEqual({
		run: null,
		requested: false,
	});
	expect(
		await requestRefreshCancel(db, "account", run.id, "2026-10-29T01:01:00.000Z"),
	).toMatchObject({
		requested: true,
		run: {
			status: "running",
			phase: "repos",
			cancelRequested: true,
			updatedAt: "2026-10-29T01:01:00.000Z",
			finishedAt: null,
		},
	});
	await saveRefreshRun(db, { ...running, updatedAt: "2026-10-29T01:02:00.000Z" });
	expect(await getRefreshRun(db, "account", run.id)).toMatchObject({
		status: "running",
		cancelRequested: true,
		completedRepos: 0,
		updatedAt: "2026-10-29T01:02:00.000Z",
	});
	const others = await createRefreshRun(
		db,
		"other",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	await saveRefreshRun(db, { ...others, status: "running", cancelRequested: true });
	await saveRefreshRun(db, { ...others, status: "running", cancelRequested: false });
	expect(await getRefreshRun(db, "other", others.id)).toMatchObject({ cancelRequested: true });
});
it("cancels a queued run atomically so only the runner can finish a running one", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	expect(await requestRefreshCancel(db, "account", run.id, "2026-10-29T01:01:00.000Z")).toEqual({
		requested: true,
		run: {
			...run,
			status: "cancelled",
			phase: "done",
			cancelRequested: true,
			updatedAt: "2026-10-29T01:01:00.000Z",
			finishedAt: "2026-10-29T01:01:00.000Z",
		},
	});
	expect(await activeRefreshRun(db, "account")).toBeNull();
	expect(
		await requestRefreshCancel(db, "account", run.id, "2026-10-29T01:02:00.000Z"),
	).toMatchObject({
		requested: false,
		run: {
			status: "cancelled",
			cancelRequested: true,
			finishedAt: "2026-10-29T01:01:00.000Z",
		},
	});
	await expect(saveRefreshRun(db, { ...run, status: "running" })).rejects.toThrow();
	expect((await getRefreshRun(db, "account", run.id))?.status).toBe("cancelled");
});
it.each(["completed", "partial", "failed"] as const)(
	"makes a pending cancellation win over a stale %s settlement",
	async (status) => {
		const db = await fixture();
		const now = "2026-10-29T01:00:00.000Z";
		const run = await createRefreshRun(
			db,
			"account",
			parseRefreshParams({}, new Date(now)),
			"manual",
			now,
		);
		const running = { ...run, status: "running" as const, phase: "repos" as const };
		await saveRefreshRun(db, running);
		await requestRefreshCancel(db, "account", run.id, "2026-10-29T01:01:00.000Z");
		const settled = {
			...addRefreshRequests(running, "b", { graphql: 1, rest: 2 }),
			status,
			phase: "done" as const,
			partial: status !== "completed",
			errorCode: status === "failed" ? "github_error" : null,
			updatedAt: "2026-10-29T01:02:00.000Z",
			finishedAt: "2026-10-29T01:02:00.000Z",
		};
		await saveRefreshRun(db, settled);
		expect(await getRefreshRun(db, "account", run.id)).toMatchObject({
			status: "cancelled",
			phase: "done",
			cancelRequested: true,
			requests: 3,
			requestBreakdown: { total: 3, graphql: 1, rest: 2 },
			errorCode: status === "failed" ? "github_error" : null,
			updatedAt: "2026-10-29T01:02:00.000Z",
			finishedAt: "2026-10-29T01:02:00.000Z",
		});
		expect(await activeRefreshRun(db, "account")).toBeNull();
		await saveRefreshRun(db, {
			...settled,
			updatedAt: "2026-10-29T01:03:00.000Z",
			finishedAt: "2026-10-29T01:03:00.000Z",
		});
		expect(await getRefreshRun(db, "account", run.id)).toMatchObject({
			status: "cancelled",
			finishedAt: "2026-10-29T01:02:00.000Z",
		});
		await expect(
			saveRefreshRun(db, { ...running, updatedAt: "2026-10-29T01:04:00.000Z" }),
		).rejects.toThrow();
	},
);
it("keeps a settled run settled when the cancellation arrives after settlement", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const completed = {
		...run,
		status: "completed" as const,
		phase: "done" as const,
		updatedAt: "2026-10-29T01:02:00.000Z",
		finishedAt: "2026-10-29T01:02:00.000Z",
	};
	await saveRefreshRun(db, completed);
	expect(await requestRefreshCancel(db, "account", run.id, "2026-10-29T01:03:00.000Z")).toEqual({
		run: completed,
		requested: false,
	});
	expect(await getRefreshRun(db, "account", run.id)).toEqual(completed);
});
it("merges safe failure metadata per repository without duplicating codes", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const run = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const failure = {
		dimension: "actions",
		code: "github_error",
		httpStatus: 500,
		graphqlType: null,
		graphqlPath: null,
	};
	const once = addRefreshPartialReasons(
		{ ...run, partial: true },
		"octo/one",
		["actions:github_error"],
		[failure],
	);
	expect(once.partialReasons).toEqual([
		{ repo: "octo/one", codes: ["actions:github_error"], failures: [failure] },
	]);
	const twice = addRefreshPartialReasons(
		once,
		"octo/one",
		["actions:github_error", "prs:partial"],
		[
			failure,
			{
				dimension: "prs",
				code: "graphql_partial",
				httpStatus: null,
				graphqlType: "FORBIDDEN",
				graphqlPath: ["node", "pullRequests", "nodes", "0", "title"],
			},
		],
	);
	expect(twice.partialReasons).toEqual([
		{
			repo: "octo/one",
			codes: ["actions:github_error", "prs:partial"],
			failures: [
				failure,
				{
					dimension: "prs",
					code: "graphql_partial",
					httpStatus: null,
					graphqlType: "FORBIDDEN",
					graphqlPath: ["node", "pullRequests", "nodes", "0", "title"],
				},
			],
		},
	]);
	expect(addRefreshPartialReasons(twice, "octo/one", [], [])).toBe(twice);
});
it("records queued and per-step timings without inventing missed attempts", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const created = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	expect(created.timings).toEqual({ queuedAt: now, a: null, repos: [] });
	const aStarted = startRefreshStep({ ...created, status: "running" }, "2026-10-29T01:00:01.000Z");
	expect(startRefreshStep(aStarted, "2026-10-29T01:00:30.000Z").timings?.a).toEqual(
		aStarted.timings?.a,
	);
	const aFinished = completeRefreshStepAttempt(aStarted, "2026-10-29T01:00:02.000Z", true, true);
	expect(aFinished.timings?.a).toEqual({
		startedAt: "2026-10-29T01:00:01.000Z",
		finishedAt: "2026-10-29T01:00:02.000Z",
		attempts: 1,
		reused: true,
	});
	const repos = { ...aFinished, phase: "repos" as const, repos: ["octo/one", "octo/two"] };
	const repoStarted = startRefreshStep(repos, "2026-10-29T01:00:03.000Z");
	expect(repoStarted.timings?.repos).toEqual([
		{
			repo: "octo/one",
			startedAt: "2026-10-29T01:00:03.000Z",
			finishedAt: null,
			attempts: 0,
		},
	]);
	const retrying = completeRefreshStepAttempt(repoStarted, "2026-10-29T01:00:04.000Z", false);
	expect(retrying.timings?.repos[0]).toEqual({
		repo: "octo/one",
		startedAt: "2026-10-29T01:00:03.000Z",
		finishedAt: null,
		attempts: 1,
	});
	const resumed = startRefreshStep(retrying, "2026-10-29T01:00:09.000Z");
	expect(resumed.timings?.repos[0]?.startedAt).toBe("2026-10-29T01:00:03.000Z");
	const done = completeRefreshStepAttempt(resumed, "2026-10-29T01:00:10.000Z", true);
	expect(closeRefreshStep(aFinished, "2026-10-29T01:00:20.000Z")).toEqual(aFinished);
	expect(closeRefreshStep(done, "2026-10-29T01:00:20.000Z")).toEqual(done);
	expect(done.timings?.repos[0]).toEqual({
		repo: "octo/one",
		startedAt: "2026-10-29T01:00:03.000Z",
		finishedAt: "2026-10-29T01:00:10.000Z",
		attempts: 2,
	});
	const cancelled = closeRefreshStep(retrying, "2026-10-29T01:00:20.000Z");
	expect(cancelled.timings?.repos[0]).toEqual({
		repo: "octo/one",
		startedAt: "2026-10-29T01:00:03.000Z",
		finishedAt: "2026-10-29T01:00:20.000Z",
		attempts: 1,
	});
	const next = startRefreshStep({ ...done, completedRepos: 1 }, "2026-10-29T01:00:21.000Z");
	expect(next.timings?.repos[1]).toMatchObject({ repo: "octo/two", attempts: 0 });
	expect(
		completeRefreshStepAttempt(aFinished, "2026-10-29T01:00:22.000Z", true).timings?.a,
	).toMatchObject({ reused: true, attempts: 2 });
	expect(closeRefreshStep(created, "2026-10-29T01:00:00.500Z")).toBe(created);
	expect(completeRefreshStepAttempt(created, "2026-10-29T01:00:00.500Z", true)).toBe(created);
	const unstarted = { ...created, phase: "repos" as const, repos: ["octo/one"] };
	expect(closeRefreshStep(unstarted, "2026-10-29T01:00:23.000Z")).toBe(unstarted);
	expect(completeRefreshStepAttempt(unstarted, "2026-10-29T01:00:23.000Z", true)).toBe(unstarted);
	const mismatched = { ...repoStarted, repos: ["octo/other"] };
	expect(closeRefreshStep(mismatched, "2026-10-29T01:00:24.000Z")).toBe(mismatched);
	expect(completeRefreshStepAttempt(mismatched, "2026-10-29T01:00:24.000Z", true)).toBe(mismatched);
});
it("adds timings only to new runs and leaves historical payloads unbackfilled", async () => {
	const db = await fixture();
	const now = "2026-10-29T01:00:00.000Z";
	const created = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const { timings: _dropped, ...historical } = created;
	expect(closeRefreshStep(historical, "2026-10-29T01:00:05.000Z")).toBe(historical);
	expect(completeRefreshStepAttempt(historical, "2026-10-29T01:00:05.000Z", true)).toBe(historical);
	const reposOnly = { ...historical, phase: "repos" as const, repos: ["octo/one"] };
	expect(closeRefreshStep(reposOnly, "2026-10-29T01:00:05.000Z")).toBe(reposOnly);
	expect(completeRefreshStepAttempt(reposOnly, "2026-10-29T01:00:05.000Z", true)).toBe(reposOnly);
	expect(startRefreshStep(historical, "2026-10-29T01:00:05.000Z")).toBe(historical);
	const resumed = {
		...reposOnly,
		completedRepos: 1,
		repos: ["octo/one", "octo/two"],
	};
	const started = startRefreshStep(resumed, "2026-10-29T01:00:05.000Z");
	expect(started).toBe(resumed);
	expect(completeRefreshStepAttempt(started, "2026-10-29T01:00:06.000Z", true)).toBe(resumed);
	expect(closeRefreshStep(started, "2026-10-29T01:00:07.000Z")).toBe(resumed);
	await saveRefreshRun(db, historical);
	expect((await getRefreshRun(db, "account", created.id))?.timings).toBeUndefined();
});
