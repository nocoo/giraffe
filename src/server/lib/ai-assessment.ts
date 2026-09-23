import type { JudgmentResult, RepositoryReport, ReviewInput } from "../../lib/ai-review";
import type { RepoAssessment } from "../../lib/repo-assessment";
import type { Env } from "../env";
import { assessmentInput } from "./ai-assessment-input";
import { judgeRepository, summarizeRepository } from "./ai-models";
import { loadAiConfig } from "./ai-settings";
import { createDb, type Db } from "./db/d1";
import { ApiError } from "./errors";
import { checkFactoryCapacity } from "./factory-retention";

type ReviewRow = {
	account_id: string;
	repo: string;
	job_id: string;
	source_version: string;
	source_at: string;
	stage: "judgment" | "summary" | "complete" | "failed";
	input: string | null;
	judgment: string | null;
	report: string | null;
	report_version: string | null;
	report_at: string | null;
	error: string | null;
	attempts: number;
};
const bytes = (text: string) => new TextEncoder().encode(text).length;
function bounded(value: unknown): string {
	const text = JSON.stringify(value);
	if (bytes(text) > 250_000)
		throw new ApiError(422, "ai_capacity", "Assessment data limit reached");
	return text;
}
export async function aiConfigured(db: Db): Promise<boolean> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM ai_settings").first<{ n: number }>();
	return row?.n === 2;
}
export async function readAssessment(
	db: Db,
	account: string,
	repo: string,
): Promise<RepoAssessment> {
	const row = await db
		.prepare("SELECT * FROM ai_reviews WHERE account_id=? AND repo=?")
		.bind(account, repo)
		.first<ReviewRow>();
	const source = await db
		.prepare(
			"SELECT s.version,v.refreshed_at FROM factory_repo_state s JOIN factory_repo_versions v ON v.account_id=s.account_id AND v.repo=s.repo AND v.version=s.version WHERE s.account_id=? AND s.repo=?",
		)
		.bind(account, repo)
		.first<{ version: string; refreshed_at: string }>();
	const superseded = source && row && source.version !== row.source_version;
	return {
		account_id: account,
		repo,
		status: row && !superseded ? row.stage : (await aiConfigured(db)) ? "missing" : "unconfigured",
		sourceVersion: source?.version ?? row?.source_version ?? null,
		sourceAt: source?.refreshed_at ?? row?.source_at ?? null,
		reportVersion: row?.report_version ?? null,
		reportAt: row?.report_at ?? null,
		judgment: row?.judgment ? (JSON.parse(row.judgment) as JudgmentResult) : null,
		report: row?.report ? (JSON.parse(row.report) as RepositoryReport) : null,
		error: row?.error ?? null,
	};
}
export async function dueAssessments(db: Db, now: string): Promise<string[]> {
	const rows = await db
		.prepare(
			"SELECT job_id FROM ai_reviews WHERE stage IN ('judgment','summary') AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at LIMIT 20",
		)
		.bind(now, now)
		.all<{ job_id: string }>();
	return rows.results.map((row) => row.job_id);
}
export async function executeAssessment(
	env: Env,
	id: string,
	clock = () => new Date().toISOString(),
): Promise<string | null> {
	const db = createDb(env.DB);
	const token = crypto.randomUUID();
	const started = clock();
	const until = new Date(Date.parse(started) + 180_000).toISOString();
	const claim = await db
		.prepare(
			"UPDATE ai_reviews SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE job_id=? AND stage IN ('judgment','summary') AND next_at<=? AND (lease_until IS NULL OR lease_until<=?)",
		)
		.bind(token, until, id, started, started)
		.run();
	if (!claim.meta.changes) return null;
	const row = await db
		.prepare("SELECT * FROM ai_reviews WHERE job_id=? AND lease_token=?")
		.bind(id, token)
		.first<ReviewRow>();
	if (!row) return null;
	let next: string | null = null;
	try {
		if (row.attempts > 3) throw new Error("Assessment attempt limit");
		const config = await loadAiConfig(env, row.stage === "judgment" ? "judgment" : "summary");
		if (!config) throw new ApiError(409, "ai_not_configured", "AI settings missing");
		const input =
			row.stage === "summary" && row.input
				? (JSON.parse(row.input) as ReviewInput)
				: await assessmentInput(db, row.account_id, row.repo, row.source_version);
		const inputJson = bounded(input);
		const result =
			row.stage === "judgment"
				? bounded(await judgeRepository(config, input))
				: bounded(
						await summarizeRepository(
							config,
							input,
							JSON.parse(row.judgment as string) as JudgmentResult,
						),
					);
		await checkFactoryCapacity(db, row.account_id, bytes(inputJson) + bytes(result));
		const now = clock();
		const sql =
			row.stage === "judgment"
				? "UPDATE ai_reviews SET stage='summary',input=?,judgment=?,error=NULL,attempts=0,next_at=?,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND lease_until>?"
				: "UPDATE ai_reviews SET stage='complete',input=NULL,report=?,report_version=source_version,report_at=?,error=NULL,attempts=0,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND lease_until>?";
		const values =
			row.stage === "judgment"
				? [inputJson, result, now, id, token, now]
				: [result, now, id, token, now];
		const saved = await db
			.prepare(sql)
			.bind(...values)
			.run();
		if (saved.meta.changes && row.stage === "judgment") next = now;
	} catch (error) {
		const code =
			error instanceof ApiError &&
			["ai_capacity", "ai_source_missing", "ai_not_configured", "factory_capacity"].includes(
				error.code,
			)
				? error.code
				: "ai_error";
		const terminal = row.attempts >= 3 || code !== "ai_error";
		const now = clock();
		const retryAt = new Date(Date.parse(now) + row.attempts * 60_000).toISOString();
		const saved = await db
			.prepare(
				"UPDATE ai_reviews SET stage=?,error=?,next_at=?,lease_token=NULL,lease_until=NULL WHERE job_id=? AND lease_token=? AND lease_until>?",
			)
			.bind(terminal ? "failed" : row.stage, code, retryAt, id, token, now)
			.run();
		if (saved.meta.changes && !terminal) next = retryAt;
	}
	return next;
}

export async function dispatchAssessment(
	env: Env,
	account: string,
	repo: string,
	version: string,
): Promise<void> {
	try {
		const row = await createDb(env.DB)
			.prepare(
				"SELECT job_id FROM ai_reviews WHERE account_id=? AND repo=? AND source_version=? AND stage='judgment'",
			)
			.bind(account, repo, version)
			.first<{ job_id: string }>();
		if (row) await env.FACTORY_QUEUE.send({ reviewId: row.job_id });
	} catch {
		// The scheduled D1 outbox scan recovers delivery failures without failing GitHub refreshes.
	}
}
