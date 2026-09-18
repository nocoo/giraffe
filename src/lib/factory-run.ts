import { factoryWindow } from "./factory";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryStreamName,
	type FactoryWindow,
} from "./factory-types";
import { REPO_SNAPSHOT_TABS, SITE_SNAPSHOT_KINDS } from "./snapshot-kinds";

export const RUN_COOLDOWN_MS = 60_000;
export const REPO_COOLDOWN_MS = 15 * 60_000;
export const RUN_LEASE_MS = 90_000;
export const RUN_MAX_RETRIES = 3;
export type RunStatus = "running" | "paused" | "completed" | "partial" | "cancelled" | "failed";
export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type StepKind =
	| "inventory"
	| "restore"
	| "contributions"
	| "metadata"
	| FactoryStreamName
	| "commit"
	| "snapshot"
	| "publish";
export type FactoryRunStep = {
	kind: StepKind;
	resource?: string;
	snapshotCursor?: number;
	repo: string | null;
	status: StepStatus;
	attempts: number;
	retryFailures?: number;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number;
	pages: number;
	error: string | null;
};
export type FactoryRun = {
	id: string;
	account_id: string;
	owner: string;
	requestKey: string;
	selection?: RunSelection;
	mode: "catalog" | "refresh";
	repos: string[];
	siteRepos?: string[];
	repoIds: Record<string, string>;
	window: FactoryWindow;
	steps: FactoryRunStep[];
	cursor: number;
	status: RunStatus;
	startedAt: string;
	updatedAt: string;
	finishedAt: string | null;
	nextAttemptAt: string;
	requests: number;
	version: number;
	checkpoint: FactorySnapshot | null;
	restoreCursor: number;
};
export type RepoRefreshState = {
	attemptRunId?: string;
	attemptStatus?: string;
	observation?: FactoryRepo["observation"];
	repo: string;
	refreshedAt: string | null;
	status: "success" | "failed" | "partial";
	nextAllowedAt: string;
	attemptedAt?: string;
	durationMs?: number;
	retries?: number;
	error?: string | null;
	version?: string | null;
	coverage?: number;
};
export type FactoryRunView = Omit<FactoryRun, "checkpoint"> & {
	progress: ReturnType<typeof runProgress>;
	leaseUntil: string | null;
};
export type FactoryRunResponse = {
	storage?: { resourceBytes: number; totalBytes?: number; limitBytes: number };
	account_id: string;
	serverNow: string;
	nextAllowedAt: string | null;
	current: FactoryRunView | null;
	history: FactoryRunView[];
	repositories: RepoRefreshState[];
	catalog: FactoryRepo[];
	catalogUpdatedAt: string | null;
	catalogComplete: boolean;
	publication: string | null;
};
export type RunSelection = {
	scope: "all" | "selected" | "filter" | "stale" | "failed";
	repos?: string[];
	order?: string[];
	repo?: string;
	language?: string;
	topic?: string;
	query?: string;
};
export function selectRunRepos(
	repos: FactoryRepo[],
	states: Pick<RepoRefreshState, "repo" | "refreshedAt" | "status" | "nextAllowedAt">[],
	input: RunSelection,
	now: string,
): FactoryRepo[] {
	if (input.scope === "selected") {
		const names = input.repos ?? [];
		if (new Set(names).size !== names.length) throw new Error("duplicate repository");
		return names.map((name) => {
			const repo = repos.find((r) => r.name === name);
			if (!repo) throw new Error("repository outside catalog");
			return repo;
		});
	}
	const query = input.query?.trim().toLowerCase();
	return repos.filter((repo) => {
		const state = states.find((s) => s.repo === repo.name);
		if (input.scope === "stale")
			return (
				!state?.refreshedAt ||
				state.status !== "success" ||
				Date.parse(now) - Date.parse(state.refreshedAt) >= 86400_000
			);
		if (input.scope === "failed") return state?.status === "failed";
		return (
			input.scope !== "filter" ||
			((!input.repo || repo.name === input.repo) &&
				(!input.language || repo.language === input.language) &&
				(!input.topic || repo.topics.includes(input.topic)) &&
				(!query || `${repo.name} ${repo.description ?? ""}`.toLowerCase().includes(query)))
		);
	});
}
export function makeRun(
	id: string,
	account: string,
	owner: string,
	requestKey: string,
	mode: FactoryRun["mode"],
	repos: FactoryRepo[],
	now: string,
	states: Pick<RepoRefreshState, "repo" | "refreshedAt" | "status" | "nextAllowedAt">[] = [],
	siteRepos: string[] = repos.map((repo) => repo.name),
): FactoryRun {
	const step = (kind: StepKind, repo: string | null = null): FactoryRunStep => ({
		kind,
		repo,
		status: "pending",
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		durationMs: 0,
		pages: 0,
		error: null,
	});
	const snapshot = (resource: string, repo: string | null = null): FactoryRunStep => ({
		...step("snapshot", repo),
		resource,
	});
	const steps =
		mode === "catalog"
			? [step("inventory"), snapshot("repos"), step("restore"), step("publish")]
			: [
					step("contributions"),
					...repos.flatMap((r) => [
						step("metadata", r.name),
						...FACTORY_STREAMS.map((s) => step(s, r.name)),
						step("commit", r.name),
					]),
					snapshot("repos"),
					...siteRepos.flatMap((repo) =>
						REPO_SNAPSHOT_TABS.map((tab) => snapshot(`repo:${repo}:${tab}`, repo)),
					),
					...SITE_SNAPSHOT_KINDS.filter((kind) => kind !== "repos").map((kind) => snapshot(kind)),
					step("publish"),
				];
	for (const s of steps)
		if (
			s.kind !== "snapshot" &&
			s.repo &&
			states.some((r) => r.repo === s.repo && r.nextAllowedAt > now)
		) {
			s.status = "skipped";
			s.error = "repository_cooldown";
			s.finishedAt = now;
		}
	return {
		id,
		account_id: account,
		owner,
		requestKey,
		mode,
		repos: repos.map((r) => r.name),
		siteRepos: [...siteRepos],
		repoIds: Object.fromEntries(repos.map((r) => [r.name, r.id])),
		window: factoryWindow(now),
		steps,
		cursor: 0,
		status: "running",
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
		nextAttemptAt: now,
		requests: 0,
		version: 0,
		checkpoint: null,
		restoreCursor: 0,
	};
}
export function runProgress(run: FactoryRun, now: string) {
	const count = (status: StepStatus) => run.steps.filter((s) => s.status === status).length;
	const success = count("success"),
		failed = count("failed"),
		skipped = count("skipped");
	const completed = success + failed + skipped;
	const measured = run.steps.filter((s) => s.status === "success" && s.durationMs > 0);
	const average = measured.length
		? measured.reduce((sum, s) => sum + s.durationMs, 0) / measured.length
		: null;
	return {
		total: run.steps.length,
		completed,
		success,
		failed,
		skipped,
		current: run.steps[run.cursor] ?? null,
		etaSeconds:
			run.status === "running" && average !== null
				? Math.ceil(
						(average * (run.steps.length - completed)) / 1000 +
							Math.max(0, Date.parse(run.nextAttemptAt) - Date.parse(now)) / 1000,
					)
				: null,
	};
}
export const retryDelay = (attempt: number) => Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
