import type { SnapshotFreshness } from "./snapshot-freshness";

export type CiRun = {
	id: number;
	name: string;
	html_url: string;
	status: string;
	conclusion: string | null;
	event: string;
	head_branch: string | null;
	created_at: string;
	updated_at: string;
};
export type CiRelease = {
	id: number;
	tag_name: string;
	name: string | null;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
};
export type Outcome = "success" | "failure" | "other" | "pending";
export type Verdict = "broken" | "flaky" | "healthy" | "idle";

const DAY = 86_400_000;
export const CI_WINDOW_DAYS = 30;
export const CI_IDLE_DAYS = 14;
/** How many of the newest decisive runs describe current stability. */
export const CI_RECENT = 10;
/** Consecutive failures that mark a stream as broken rather than flaky. */
export const CI_BROKEN_STREAK = 2;
export const CI_CHRONIC_RATE = 0.5;
const CI_CHRONIC_MIN = 4;
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function outcomeOf(run: Pick<CiRun, "status" | "conclusion">): Outcome {
	if (run.status !== "completed" || run.conclusion === null) return "pending";
	if (run.conclusion === "success") return "success";
	return FAILED.has(run.conclusion) ? "failure" : "other";
}

const byNewest = (a: CiRun, b: CiRun) => b.created_at.localeCompare(a.created_at) || b.id - a.id;

export function classifyStream(runs: CiRun[], now: string) {
	const since = Date.parse(now) - CI_WINDOW_DAYS * DAY;
	const sorted = [...runs].sort(byNewest);
	const lastRun = sorted[0]?.created_at ?? null;
	const inactive = lastRun !== null && Date.parse(now) - Date.parse(lastRun) >= CI_IDLE_DAYS * DAY;
	const inWindow = sorted.filter((r) => Date.parse(r.created_at) >= since);
	const decisive = inWindow.filter((r) => {
		const o = outcomeOf(r);
		return o === "success" || o === "failure";
	});
	const recent = decisive.slice(0, CI_RECENT);
	let streak = 0;
	for (const r of recent) {
		if (outcomeOf(r) !== "failure") break;
		streak++;
	}
	const failures = recent.filter((r) => outcomeOf(r) === "failure").length;
	let flips = 0;
	for (let i = 1; i < recent.length; i++)
		if (outcomeOf(recent[i] as CiRun) !== outcomeOf(recent[i - 1] as CiRun)) flips++;
	const lastSuccess = decisive.find((r) => outcomeOf(r) === "success")?.created_at ?? null;
	const chronic = recent.length >= CI_CHRONIC_MIN && failures / recent.length >= CI_CHRONIC_RATE;
	const verdict: Verdict =
		inactive || !recent.length
			? "idle"
			: streak > 0 && (streak >= CI_BROKEN_STREAK || chronic)
				? "broken"
				: failures
					? "flaky"
					: "healthy";
	const reason =
		verdict === "idle"
			? inactive
				? `${CI_IDLE_DAYS} 天没有运行`
				: `${CI_WINDOW_DAYS} 天内没有判定结果`
			: verdict === "broken"
				? streak >= CI_BROKEN_STREAK
					? `连续 ${streak} 次失败`
					: `近 ${recent.length} 次失败 ${failures} 次`
				: verdict === "flaky"
					? recent.length === 1
						? "仅 1 次判定且失败，样本不足"
						: streak
							? "最近一次失败"
							: `近 ${recent.length} 次判定失败 ${failures} 次`
					: `近 ${recent.length} 次全部成功`;
	return {
		verdict,
		reason,
		streak,
		failingSince: streak ? (recent[streak - 1] as CiRun).created_at : null,
		lastSuccess,
		lastRun,
		decided: recent.length,
		failures,
		rate: recent.length ? (recent.length - failures) / recent.length : null,
		flips,
		// More than one failure in the recent window is a pattern, not a one-off.
		recurring: verdict === "flaky" && failures > 1,
		/** Why a broken stream is broken: an unbroken run of failures, or mostly failing between passes. */
		brokenBy:
			verdict !== "broken"
				? null
				: streak >= CI_BROKEN_STREAK
					? ("streak" as const)
					: ("chronic" as const),
		pending: inWindow.filter((r) => outcomeOf(r) === "pending").length,
		recent: inWindow.slice(0, CI_RECENT).map((r) => ({
			outcome: outcomeOf(r),
			at: r.created_at,
			id: r.id,
			event: r.event,
			branch: r.head_branch,
		})),
	};
}
export type StreamHealth = ReturnType<typeof classifyStream>;

export function releaseHealth(
	releases: CiRelease[],
	pipeline: { verdict: Verdict; streak: number } | null,
	now: string,
) {
	const published = releases
		.filter((r): r is CiRelease & { published_at: string } => !r.draft && r.published_at !== null)
		.sort((a, b) => b.published_at.localeCompare(a.published_at));
	const days = (a: string, b: string) =>
		Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY);
	const gaps = published
		.slice(0, -1)
		.map((r, i) =>
			days((published[i + 1] as CiRelease & { published_at: string }).published_at, r.published_at),
		);
	const sorted = [...gaps].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const latest = published[0];
	return {
		latest: latest?.tag_name ?? null,
		latestAt: latest?.published_at ?? null,
		ageDays: latest ? days(latest.published_at, now) : null,
		cadenceDays: sorted.length
			? sorted.length % 2
				? (sorted[mid] as number)
				: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
			: null,
		count: published.length,
		recent30: published.filter(
			(r) => Date.parse(r.published_at) >= Date.parse(now) - CI_WINDOW_DAYS * DAY,
		).length,
		pipeline: (pipeline?.verdict ?? "none") as Verdict | "none",
		pipelineStreak: pipeline?.streak ?? 0,
	};
}

export type CiEntry = {
	repo: string;
	fetched_at: string;
	truncated: boolean;
	runs: CiRun[];
	default_branch?: string;
	releases?: CiRelease[] | null;
};
const RANK: Record<Verdict | "none", number> = {
	broken: 0,
	flaky: 1,
	healthy: 2,
	idle: 3,
	none: 4,
};

export const BOT_WORKFLOW = "Dependabot 更新任务";
/** GitHub names some runs per instance; fold them so one workflow is one stream. */
export function workflowName(run: Pick<CiRun, "name" | "event">): string {
	if (run.event === "dynamic" || / - Update #\d+$/.test(run.name)) return BOT_WORKFLOW;
	return run.name.replace(/\s+#?\d{2,}$/, "").trim() || "未命名工作流";
}
type Scope = "main" | "branch" | "bot";
const SCOPE_RANK: Record<Scope, number> = { main: 0, branch: 1, bot: 2 };

function laneOf(run: CiRun, main: string | undefined) {
	const workflow = workflowName(run);
	const scope: Scope =
		workflow === BOT_WORKFLOW
			? "bot"
			: main && run.head_branch === main && !run.event.startsWith("pull_request")
				? "main"
				: "branch";
	return { workflow, scope, branch: scope === "bot" ? (main ?? null) : run.head_branch };
}

function repoSummary(entry: CiEntry, own: ReturnType<typeof repoStreams>, now: string) {
	const main = own.filter((s) => s.scope === "main");
	const count = (v: Verdict) => main.filter((s) => s.verdict === v).length;
	const verdict: Verdict | "none" = !main.length
		? "none"
		: count("broken")
			? "broken"
			: count("flaky")
				? "flaky"
				: count("healthy")
					? "healthy"
					: "idle";
	const pipeline =
		main
			.filter((s) => /release|publish|deploy|cd\b/i.test(s.workflow))
			.sort((a, b) => RANK[a.verdict] - RANK[b.verdict])[0] ?? null;
	const decided = main.reduce((n, s) => n + s.decided, 0);
	const failed = main.reduce((n, s) => n + s.failures, 0);
	return {
		repo: entry.repo,
		verdict,
		brokenWorkflows: count("broken"),
		flakyWorkflows: count("flaky"),
		healthyWorkflows: count("healthy"),
		idleWorkflows: count("idle"),
		totalWorkflows: main.length,
		nonDefaultBranchStreams: own.filter((s) => s.scope === "branch").length,
		nonDefaultBranchFailures: entry.runs.filter(
			(r) =>
				laneOf(r, entry.default_branch).scope === "branch" &&
				outcomeOf(r) === "failure" &&
				Date.parse(r.created_at) >= Date.parse(now) - CI_WINDOW_DAYS * DAY,
		).length,
		botStreams: own.filter((s) => s.scope === "bot").length,
		rate: decided ? (decided - failed) / decided : null,
		lastRun:
			main
				.map((s) => s.lastRun ?? "")
				.sort()
				.at(-1) || null,
		fetched_at: entry.fetched_at,
		truncated: entry.truncated,
		release: entry.releases ? releaseHealth(entry.releases, pipeline, now) : null,
	};
}

function repoStreams(entry: CiEntry, now: string) {
	const since = Date.parse(now) - CI_WINDOW_DAYS * DAY;
	const lanes = new Map<
		string,
		{ workflow: string; branch: string | null; scope: Scope; runs: CiRun[] }
	>();
	for (const run of entry.runs) {
		const lane = laneOf(run, entry.default_branch);
		if (lane.scope === "branch" && !(Date.parse(run.created_at) >= since)) continue;
		const key = JSON.stringify([lane.workflow, lane.scope, lane.branch]);
		const slot = lanes.get(key) ?? { ...lane, runs: [] };
		slot.runs.push(run);
		lanes.set(key, slot);
	}
	return [...lanes.values()].map(({ runs, ...lane }) => ({
		repo: entry.repo,
		...lane,
		...classifyStream(runs, now),
	}));
}

export function ciReport(entries: CiEntry[], now: string) {
	const end = Date.parse(now.slice(0, 10));
	const daily = Array.from({ length: CI_WINDOW_DAYS }, (_, i) => ({
		x: new Date(end - (CI_WINDOW_DAYS - 1 - i) * DAY).toISOString().slice(0, 10),
		success: 0,
		failure: 0,
		other: 0,
	}));
	const dayIndex = new Map(daily.map((d, i) => [d.x, i]));
	const streams = [];
	const repos: ReturnType<typeof repoSummary>[] = [];
	for (const entry of entries) {
		for (const run of entry.runs) {
			const slot = daily[dayIndex.get(run.created_at.slice(0, 10)) ?? -1];
			const o = outcomeOf(run);
			if (slot && o !== "pending" && laneOf(run, entry.default_branch).scope !== "bot") slot[o]++;
		}
		const own = repoStreams(entry, now);
		repos.push(repoSummary(entry, own, now));
		streams.push(...own);
	}
	streams.sort(
		(a, b) =>
			RANK[a.verdict] - RANK[b.verdict] ||
			SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
			b.streak - a.streak ||
			a.repo.localeCompare(b.repo) ||
			a.workflow.localeCompare(b.workflow) ||
			(a.branch ?? "").localeCompare(b.branch ?? ""),
	);
	repos.sort(
		(a, b) =>
			RANK[a.verdict] - RANK[b.verdict] ||
			b.brokenWorkflows - a.brokenWorkflows ||
			a.repo.localeCompare(b.repo),
	);
	const main = streams.filter((s) => s.scope === "main");
	const tally = (v: Verdict) => main.filter((s) => s.verdict === v).length;
	const repoTally = (v: Verdict | "none") => repos.filter((r) => r.verdict === v).length;
	return {
		streams,
		repos,
		daily,
		totals: {
			brokenWorkflows: tally("broken"),
			flakyWorkflows: tally("flaky"),
			recurringWorkflows: main.filter((s) => s.recurring).length,
			healthyWorkflows: tally("healthy"),
			idleWorkflows: tally("idle"),
			brokenRepos: repoTally("broken"),
			flakyRepos: repoTally("flaky"),
			healthyRepos: repoTally("healthy"),
			idleRepos: repoTally("idle"),
			unknownRepos: repoTally("none"),
			totalRepos: repos.length,
			totalWorkflows: main.length,
			nonDefaultBranchStreams: streams.filter((s) => s.scope === "branch").length,
			nonDefaultBranchFailures: repos.reduce((n, r) => n + r.nonDefaultBranchFailures, 0),
			botStreams: streams.filter((s) => s.scope === "bot").length,
			truncatedRepos: entries.filter((e) => e.truncated).length,
		},
	};
}
export type CiReport = ReturnType<typeof ciReport>;
export type CiReportResponse = CiReport & {
	freshness?: SnapshotFreshness;
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	now: string;
	/** Participating repositories with no saved Actions snapshot; unknown, not healthy. */
	unsaved: string[];
};
