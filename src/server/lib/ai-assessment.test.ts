import { beforeEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { sqliteFixture } from "../../../tests/fixtures/sqlite";
import type { JudgmentResult, RepositoryReport } from "../../lib/ai-review";
import { defaultAiSettings } from "../../lib/ai-settings";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Env } from "../env";
import {
	dispatchAssessment,
	dueAssessments,
	executeAssessment,
	readAssessment,
} from "./ai-assessment";
import { judgeRepository, summarizeRepository } from "./ai-models";
import { loadAiConfig } from "./ai-settings";
import { createDb } from "./db/d1";
import { claimRun, startRun } from "./db/factory-runs";
import { ApiError } from "./errors";
import { repositoryWrites } from "./factory-publish";
import { factoryStorage } from "./factory-retention";

vi.mock("./ai-models", async (original) => ({
	...(await original<typeof import("./ai-models")>()),
	judgeRepository: vi.fn(),
	summarizeRepository: vi.fn(),
}));
vi.mock("./ai-settings", () => ({ loadAiConfig: vi.fn() }));
const snap = factoryFixture();
const at = snap.fetched_at;
const judgment: JudgmentResult = { templateVersion: 1, model: "jev-latest", judgments: [] };
const section = { status: "unknown" as const, summary: "Missing evidence", evidenceIds: [] };
const report: RepositoryReport = {
	schemaVersion: 1,
	summary: "Needs review",
	overall: "unknown",
	security: section,
	pullRequests: section,
	issues: section,
	delivery: { ...section, trend: "unknown" },
	actions: [],
	limitations: ["Partial data"],
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadAiConfig).mockImplementation(async (_env, kind) => ({
		...defaultAiSettings(kind),
		apiKey: "fake",
	}));
	vi.mocked(judgeRepository).mockResolvedValue(judgment);
	vi.mocked(summarizeRepository).mockResolvedValue(report);
});
async function setup(configured = true) {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,?,?,?,?,?)",
		)
		.bind(snap.account_id, "nocoo", "encrypted", "fake", at, at)
		.run();
	if (configured)
		for (const kind of ["summary", "judgment"])
			await raw
				.prepare(
					"INSERT INTO ai_settings VALUES(?, 'encrypted',1,'fake','https://ai.example','openai','apiKey',?)",
				)
				.bind(kind, at)
				.run();
	const db = createDb(raw);
	const run = makeRun("review_run", snap.account_id, "nocoo", "key", "catalog", [], at);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, at);
	if (!lease) throw new Error("fixture");
	const repo = structuredClone(snap.repos[0]);
	if (!repo) throw new Error("fixture");
	repo.observation = { version: run.id, refreshedAt: at, window: snap.window, source: "run" };
	for (const stream of FACTORY_STREAMS) {
		repo.coverage[stream].status = "complete";
		await raw
			.prepare("INSERT INTO factory_resources VALUES(?,?,?,?)")
			.bind(
				run.id,
				repo.name,
				stream,
				JSON.stringify({ runId: run.id, items: [], coverage: repo.coverage[stream] }),
			)
			.run();
	}
	const publish = async () => {
		const nextDb = createDb(raw);
		return nextDb.batch(await repositoryWrites(nextDb, lease, at, repo, repo.name, null));
	};
	await publish();
	const env = { DB: raw } as Env;
	const ids = () => dueAssessments(createDb(raw), at);
	const read = () => readAssessment(createDb(raw), snap.account_id, repo.name);
	return { raw, env, repo, lease, publish, ids, read };
}
it("queues only configured accepted new versions, then persists both stages exactly once", async () => {
	const { raw, env, repo, publish, ids, read } = await setup();
	const [id] = await ids();
	expect(id).toBeTruthy();
	await publish();
	expect(await ids()).toEqual([id]);
	expect((await read()).status).toBe("judgment");
	expect(await executeAssessment(env, id as string, () => at)).toBe(at);
	expect((await read()).status).toBe("summary");
	expect(await executeAssessment(env, id as string, () => at)).toBeNull();
	expect(await read()).toMatchObject({
		status: "complete",
		report,
		judgment,
		sourceVersion: repo.observation?.version,
		reportVersion: repo.observation?.version,
	});
	expect(await executeAssessment(env, id as string, () => at)).toBeNull();
	expect(judgeRepository).toHaveBeenCalledTimes(1);
	expect(summarizeRepository).toHaveBeenCalledTimes(1);
	const storage = await factoryStorage(createDb(raw), snap.account_id);
	expect(storage.totalBytes).toBeGreaterThan(JSON.stringify(report).length);
});
it("leaves unconfigured refreshes alone and reads never contact AI", async () => {
	const { ids, read } = await setup(false);
	expect(await ids()).toEqual([]);
	expect((await read()).status).toBe("unconfigured");
	expect(judgeRepository).not.toHaveBeenCalled();
});
it.each([
	["ai_input_too_large", false],
	["ai_request_rejected", false],
	["ai_auth_failed", false],
	["ai_timeout", true],
	["ai_provider_failed", true],
	["ai_rate_limited", true],
	["ai_invalid_judgment", true],
	["ai_invalid_report", true],
])("preserves safe %s diagnostics and retries only recoverable errors", async (code, retry) => {
	const { env, ids, read } = await setup();
	const id = (await ids())[0] as string;
	vi.mocked(judgeRepository).mockRejectedValue(new ApiError(502, code, "secret provider body"));
	const next = await executeAssessment(env, id, () => at);
	expect(next !== null).toBe(retry);
	expect(await read()).toMatchObject({ error: code, status: retry ? "judgment" : "failed" });
	expect(JSON.stringify(await read())).not.toContain("secret");
});
it("retains a previous valid report on safe terminal failure and fences superseded workers", async () => {
	const { raw, env, ids, read } = await setup();
	const id = (await ids())[0] as string;
	await executeAssessment(env, id, () => at);
	await executeAssessment(env, id, () => at);
	await raw.prepare("UPDATE ai_reviews SET job_id='new_job',stage='judgment',attempts=0").run();
	vi.mocked(judgeRepository).mockRejectedValue(new Error("secret upstream response"));
	for (let i = 0; i < 3; i++) {
		await raw.prepare("UPDATE ai_reviews SET next_at=?").bind(at).run();
		await executeAssessment(env, "new_job", () => at);
	}
	expect(await read()).toMatchObject({
		status: "failed",
		report,
		reportVersion: "review_run",
		error: "ai_error",
	});
	expect(JSON.stringify(await read())).not.toContain("secret");
	expect(await executeAssessment(env, id, () => at)).toBeNull();
});
it("does not publish after lease loss or execute duplicate concurrent deliveries", async () => {
	const { raw, env, ids, read } = await setup();
	const id = (await ids())[0] as string;
	vi.mocked(judgeRepository).mockImplementation(async () => {
		expect(await executeAssessment(env, id, () => at)).toBeNull();
		await raw
			.prepare("UPDATE ai_reviews SET job_id='replacement',lease_token=NULL,lease_until=NULL")
			.run();
		return judgment;
	});
	expect(await executeAssessment(env, id, () => at)).toBeNull();
	expect((await read()).status).toBe("judgment");
});

it("captures bounded source evidence, prioritizes open work and declares omitted/missing coverage", async () => {
	const { raw, env, ids, repo } = await setup();
	const events = Array.from({ length: 30 }, (_, i) => ({
		id: String(i),
		title: "Review",
		body: "x".repeat(1400),
		url: "https://github.com/nocoo/app/issues/1",
		state: i === 29 ? "open" : "closed",
		at: String(i),
		createdAt: at,
		closedAt: null,
		mergedAt: null,
		author: "external",
	}));
	await raw
		.prepare("UPDATE factory_resources SET payload=? WHERE stream='issues'")
		.bind(JSON.stringify({ runId: "review_run", items: events }))
		.run();
	await raw.prepare("DELETE FROM factory_resources WHERE stream='alerts'").run();
	await executeAssessment(env, (await ids())[0] as string, () => at);
	const input = vi.mocked(judgeRepository).mock.calls[0]?.[1];
	expect(input?.repository.name).toBe(repo.name);
	expect(input?.events.issues).toHaveLength(24);
	expect(input?.events.issues[0]?.id).toBe("issues:29");
	expect(input?.events.issues[0]?.body).toHaveLength(1200);
	expect(input?.omitted.issues).toBe(6);
	expect(input?.coverage.alerts.status).toBe("unavailable");
});
it("fails safely for missing credentials, sources and capacity without retrying provider calls", async () => {
	for (const scenario of ["config", "source", "observation", "capacity", "budget"]) {
		const { raw, env, ids, read } = await setup();
		if (scenario === "config") vi.mocked(loadAiConfig).mockResolvedValueOnce(null);
		if (scenario === "source") await raw.prepare("DELETE FROM factory_repo_versions").run();
		if (scenario === "observation")
			await raw
				.prepare("UPDATE factory_repo_versions SET payload=json_remove(payload,'$.observation')")
				.run();
		if (scenario === "capacity")
			vi.mocked(judgeRepository).mockResolvedValueOnce({ ...judgment, model: "x".repeat(250001) });
		if (scenario === "budget") await raw.prepare("UPDATE factory_budget SET bytes=256000000").run();
		expect(await executeAssessment(env, (await ids())[0] as string, () => at)).toBeNull();
		expect((await read()).status).toBe("failed");
	}
});
it("delivers new jobs, recovers queue failures through the durable due scan, and marks no report as missing", async () => {
	const { raw, env, ids, read, repo } = await setup();
	const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
	env.FACTORY_QUEUE = { send } as unknown as Queue;
	await dispatchAssessment(env, snap.account_id, repo.name, "review_run");
	expect(await ids()).toHaveLength(1);
	await dispatchAssessment(env, snap.account_id, repo.name, "review_run");
	expect(send).toHaveBeenCalledTimes(2);
	await dispatchAssessment(env, snap.account_id, repo.name, "nonexistent");
	expect(send).toHaveBeenCalledTimes(2);
	await raw.prepare("DELETE FROM ai_reviews").run();
	expect((await read()).status).toBe("missing");
});
it("replaces a pending source while retaining last report and rejects failed or regressed refresh triggers", async () => {
	const { raw, env, ids, repo, lease, read } = await setup();
	const originalId = (await ids())[0] as string;
	await executeAssessment(env, originalId, () => at);
	await executeAssessment(env, originalId, () => at);
	const publish = async (value: typeof repo | null, error: string | null, legacy = false) => {
		const db = createDb(raw);
		await db.batch(await repositoryWrites(db, lease, at, value, repo.name, error, legacy));
	};
	const changed = structuredClone(repo);
	if (!changed.observation) throw new Error("fixture");
	changed.observation.version = "second_version";
	changed.coverage.prs.status = "unavailable";
	await publish(changed, null);
	expect((await read()).sourceVersion).toBe("review_run");
	await publish(null, "failed");
	expect((await read()).sourceVersion).toBe("review_run");
	changed.coverage.prs.status = "complete";
	await publish(changed, null);
	expect(await read()).toMatchObject({
		status: "judgment",
		sourceVersion: "second_version",
		reportVersion: "review_run",
		report,
	});
	expect((await ids())[0]).not.toBe(originalId);
	await publish(repo, null, true);
	expect(await raw.prepare("SELECT source_version FROM ai_reviews").first()).toMatchObject({
		source_version: "second_version",
	});
});

it("does not call providers again after repeated expired leases", async () => {
	const { raw, env, ids, read } = await setup();
	await raw.prepare("UPDATE ai_reviews SET attempts=3").run();
	await executeAssessment(env, (await ids())[0] as string, () => at);
	expect((await read()).status).toBe("failed");
	expect(judgeRepository).not.toHaveBeenCalled();
});
it("marks the last report stale when data refreshes with AI disabled", async () => {
	const { raw, env, ids, repo, lease, read } = await setup();
	const id = (await ids())[0] as string;
	await executeAssessment(env, id, () => at);
	await executeAssessment(env, id, () => at);
	await raw.prepare("DELETE FROM ai_settings").run();
	if (!repo.observation) throw new Error("fixture");
	repo.observation.version = "unassessed";
	const db = createDb(raw);
	await db.batch(await repositoryWrites(db, lease, at, repo, repo.name, null));
	expect(await read()).toMatchObject({
		status: "unconfigured",
		sourceVersion: "unassessed",
		reportVersion: "review_run",
		report,
	});
});
