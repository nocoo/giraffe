/**
 * CI health classification from saved GitHub Actions runs. A stream is one workflow on one lane
 * (the default branch plus release tags, or a single feature branch).
 */
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
/** How many of the newest decisive runs describe current stability. */
export const CI_RECENT = 10;
/** Consecutive failures that mark a stream as broken rather than flaky. */
export const CI_BROKEN_STREAK = 2;
/** A stream failing at least half of enough recent runs is chronically broken even between passes. */
export const CI_CHRONIC_RATE = 0.5;
const CI_CHRONIC_MIN = 4;
const BRANCH_ACTIVE_DAYS = 7;
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function outcomeOf(run: Pick<CiRun, "conclusion">): Outcome {
	if (run.conclusion === null) return "pending";
	if (run.conclusion === "success") return "success";
	return FAILED.has(run.conclusion) ? "failure" : "other";
}

const byNewest = (a: CiRun, b: CiRun) => b.created_at.localeCompare(a.created_at) || b.id - a.id;

export function classifyStream(runs: CiRun[], now: string) {
	const since = Date.parse(now) - CI_WINDOW_DAYS * DAY;
	const inWindow = [...runs].filter((r) => Date.parse(r.created_at) >= since).sort(byNewest);
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
	const verdict: Verdict = !recent.length
		? "idle"
		: streak >= CI_BROKEN_STREAK || chronic
			? "broken"
			: failures
				? "flaky"
				: "healthy";
	const reason =
		verdict === "idle"
			? `${CI_WINDOW_DAYS} 天内没有判定结果`
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
		lastRun: inWindow[0]?.created_at ?? [...runs].sort(byNewest)[0]?.created_at ?? null,
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
		recent: inWindow
			.slice(0, CI_RECENT)
			.map((r) => ({ outcome: outcomeOf(r), at: r.created_at, id: r.id })),
	};
}
export type StreamHealth = ReturnType<typeof classifyStream>;

const isTag = (ref: string) => /^v?\d+\.\d+/.test(ref);

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

function laneOf(run: CiRun, main: string) {
	const ref = run.head_branch ?? main;
	const workflow = workflowName(run);
	// Dependabot jobs fail on dependency conflicts, not on the project's own pipeline.
	const scope: Scope =
		workflow === BOT_WORKFLOW ? "bot" : ref === main || isTag(ref) ? "main" : "branch";
	return { workflow, scope, branch: scope === "branch" ? ref : main };
}

function repoSummary(entry: CiEntry, own: ReturnType<typeof repoStreams>, now: string) {
	const project = own.filter((s) => s.scope !== "bot");
	const count = (v: Verdict, scope?: Scope) =>
		project.filter((s) => s.verdict === v && (!scope || s.scope === scope)).length;
	const verdict: Verdict | "none" = !entry.runs.length
		? "none"
		: count("broken", "main")
			? "broken"
			: count("flaky") || count("broken")
				? "flaky"
				: count("healthy")
					? "healthy"
					: "idle";
	const main = project.filter((s) => s.scope === "main");
	const pipeline =
		main
			.filter((s) => /release|publish|deploy|cd\b/i.test(s.workflow))
			.sort((a, b) => RANK[a.verdict] - RANK[b.verdict])[0] ?? null;
	const decided = main.reduce((n, s) => n + s.decided, 0);
	const failed = main.reduce((n, s) => n + s.failures, 0);
	return {
		repo: entry.repo,
		verdict,
		broken: count("broken"),
		flaky: count("flaky"),
		healthy: count("healthy"),
		idle: count("idle"),
		bot: own.length - project.length,
		streams: project.length,
		rate: decided ? (decided - failed) / decided : null,
		lastRun:
			project
				.map((s) => s.lastRun ?? "")
				.sort()
				.at(-1) || null,
		fetched_at: entry.fetched_at,
		truncated: entry.truncated,
		release: entry.releases ? releaseHealth(entry.releases, pipeline, now) : null,
	};
}

function repoStreams(entry: CiEntry, now: string) {
	const main = entry.default_branch ?? "main";
	const lanes = new Map<
		string,
		{ workflow: string; branch: string; scope: Scope; runs: CiRun[] }
	>();
	for (const run of entry.runs) {
		const lane = laneOf(run, main);
		const key = `${lane.workflow}\u0000${lane.branch}`;
		const slot = lanes.get(key) ?? { ...lane, runs: [] };
		slot.runs.push(run);
		lanes.set(key, slot);
	}
	return [...lanes.values()].flatMap(({ runs, ...lane }) => {
		const health = classifyStream(runs, now);
		// Feature branches only matter while active and failing; green or abandoned ones are noise.
		const hidden =
			lane.scope === "branch" &&
			(health.verdict === "healthy" ||
				health.verdict === "idle" ||
				Date.parse(health.lastRun ?? "") < Date.parse(now) - BRANCH_ACTIVE_DAYS * DAY);
		return hidden ? [] : [{ repo: entry.repo, ...lane, ...health }];
	});
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
	const repos = [];
	for (const entry of entries) {
		const main = entry.default_branch ?? "main";
		for (const run of entry.runs) {
			const slot = daily[dayIndex.get(run.created_at.slice(0, 10)) ?? -1];
			const o = outcomeOf(run);
			if (slot && o !== "pending" && laneOf(run, main).scope !== "bot") slot[o]++;
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
			a.branch.localeCompare(b.branch),
	);
	repos.sort(
		(a, b) =>
			RANK[a.verdict] - RANK[b.verdict] || b.broken - a.broken || a.repo.localeCompare(b.repo),
	);
	const project = streams.filter((s) => s.scope !== "bot");
	const tally = (v: Verdict) => project.filter((s) => s.verdict === v).length;
	return {
		streams,
		repos,
		daily,
		totals: {
			broken: tally("broken"),
			flaky: tally("flaky"),
			recurring: project.filter((s) => s.recurring).length,
			healthy: tally("healthy"),
			idle: tally("idle"),
			bot: streams.length - project.length,
			repos: entries.length,
			truncated: entries.filter((e) => e.truncated).length,
		},
	};
}
export type CiReport = ReturnType<typeof ciReport>;
export type CiReportResponse = CiReport & {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	now: string;
	/** Participating repositories with no saved Actions snapshot; unknown, not healthy. */
	unsaved: string[];
};
