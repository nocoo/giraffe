import type {
	ActivityCoverage,
	ActivityIssue,
	ActivityPr,
	ActivityRepo,
	ActivityRun,
	ActivityWindow,
} from "../../lib/activity-types";
import type {
	FactoryEvent,
	FactoryRepo,
	FactoryStreamData,
	FactoryWindow,
} from "../../lib/factory-types";
import { unknownActivity } from "./activity";

type Saved = {
	data: FactoryStreamData;
	raw: Map<string, Record<string, unknown>>;
	snapshot: Record<string, unknown> | undefined;
};
export type ActivityInputs = Map<string, Saved>;
const inWindow = (at: string | null | undefined, window: FactoryWindow) =>
	typeof at === "string" &&
	Date.parse(at) >= Date.parse(window.since) &&
	Date.parse(at) <= Date.parse(window.until);
function covers(window: FactoryWindow, ranges: FactoryWindow[]) {
	let cursor = Date.parse(window.since);
	for (const range of [...ranges].sort(
		(left, right) => Date.parse(left.since) - Date.parse(right.since),
	)) {
		if (Date.parse(range.since) > cursor) return false;
		cursor = Math.max(cursor, Date.parse(range.until) + 1);
	}
	return cursor > Date.parse(window.until);
}
function evidence(
	repo: FactoryRepo | undefined,
	stream: string,
	inputs: ActivityInputs,
	window: FactoryWindow,
) {
	const saved = inputs.get(stream);
	if (!saved || !repo) return { items: null, coverage: unknownActivity("source_missing") };
	const data = saved.data;
	const published = repo.coverage[stream as keyof FactoryRepo["coverage"]];
	const observation = published.observation ?? repo.observation;
	const sourceWindow = observation?.window ?? window;
	const source = {
		runId: data.runId,
		fetchedAt: data.coverage.fetchedAt,
		window: sourceWindow,
		completeWindows: data.ranges,
	};
	const unavailable = (reason: string) => ({
		items: null,
		coverage: { ...unknownActivity(reason), source },
	});
	if (observation?.version !== undefined && data.runId !== observation.version)
		return unavailable("source_version_mismatch");
	if (
		Date.parse(sourceWindow.until) < Date.parse(window.since) ||
		Date.parse(sourceWindow.since) > Date.parse(window.until)
	)
		return unavailable("outside_activity_window");
	if (["pending", "unavailable"].includes(data.coverage.status))
		return unavailable(data.coverage.reason ?? "source_unavailable");
	const complete = data.coverage.status === "complete" && covers(window, data.ranges);
	const coverage: ActivityCoverage = {
		status: complete ? "complete" : "partial",
		truncated:
			data.next !== null ||
			data.coverage.status === "limited" ||
			["latest_page_only", "incomplete_pagination"].includes(data.coverage.reason ?? ""),
		reason: complete ? null : (data.coverage.reason ?? "incomplete_window"),
		source,
	};
	return {
		items: data.items.filter((item) =>
			[item.at, item.createdAt, item.closedAt, item.mergedAt].some((at) => inWindow(at, window)),
		),
		coverage,
	};
}
function metadata(item: FactoryEvent, saved: Saved | undefined) {
	const raw = saved?.raw.get(item.id);
	return item.updatedAt && raw?.updatedAt === item.updatedAt ? raw : undefined;
}
function labels(item: FactoryEvent, raw: Record<string, unknown> | undefined): string[] | null {
	if (item.labels) return item.labels;
	const rows = (raw?.labels as { nodes?: { name: string }[] } | undefined)?.nodes;
	return rows ? rows.map((row) => row.name) : null;
}
function dependency(item: FactoryEvent, tags: string[] | null) {
	return (
		item.dependency ??
		(/^(dependabot|renovate)(\[bot\])?$/i.test(item.author ?? "") ||
			(tags ?? []).some((label) => /dependenc/i.test(label)))
	);
}
function pullRequest(item: FactoryEvent, saved: Saved | undefined): ActivityPr {
	const raw = metadata(item, saved);
	return {
		...item,
		merged_at: item.mergedAt,
		merged_by: item.merged_by ?? null,
		base_ref: item.base_ref ?? (typeof raw?.baseRefName === "string" ? raw.baseRefName : null),
		bot: item.bot ?? /\[bot\]$/i.test(item.author ?? ""),
		dependency: dependency(item, labels(item, raw)),
	};
}
function issue(item: FactoryEvent, saved: Saved | undefined): ActivityIssue {
	return {
		...item,
		closed_by: item.closed_by ?? null,
		state_reason: item.state_reason ?? null,
		labels: labels(item, metadata(item, saved)) ?? [],
	};
}
function action(
	item: FactoryEvent,
	saved: Saved | undefined,
	repo: FactoryRepo | undefined,
): ActivityRun {
	const snapshot = saved?.snapshot;
	const rows =
		snapshot?.coverage &&
		(snapshot.coverage as { fetchedAt?: string }).fetchedAt === saved?.data.coverage.fetchedAt
			? (snapshot.runs as Record<string, unknown>[])
			: [];
	const raw = rows?.find((row) => String(row.id) === item.id && row.created_at === item.createdAt);
	const full = item.activityRun;
	const branch =
		full?.head_branch ?? (typeof raw?.head_branch === "string" ? raw.head_branch : null);
	const currentBranch =
		repo && repo.observation?.version === saved?.data.runId && repo.metadataAt ? repo.branch : null;
	return {
		id: Number(item.id),
		workflow_id: full?.workflow_id ?? null,
		workflow_name: full?.workflow_name ?? item.title,
		event: full?.event ?? (typeof raw?.event === "string" ? raw.event : null),
		head_branch: branch,
		head_sha: full?.head_sha ?? null,
		is_default_branch: branch && currentBranch ? branch === currentBranch : null,
		status: full?.status ?? item.state,
		conclusion: full?.conclusion ?? item.conclusion ?? null,
		run_attempt: full?.run_attempt ?? null,
		created_at: full?.created_at ?? item.createdAt,
		updated_at: full?.updated_at ?? item.updatedAt ?? null,
		run_started_at: full?.run_started_at ?? null,
		duration_s: full?.duration_s ?? null,
		html_url: full?.html_url ?? item.url,
		actor: full?.actor ?? null,
		path: full?.path ?? null,
	};
}
export function projectActivityRepo(
	name: string,
	repo: FactoryRepo | undefined,
	inputs: ActivityInputs,
	window: ActivityWindow,
): ActivityRepo {
	const prs = evidence(repo, "prs", inputs, window);
	const issues = evidence(repo, "issues", inputs, window);
	const actions = evidence(repo, "actions", inputs, window);
	const releases = evidence(repo, "releases", inputs, window);
	const prItems = prs.items?.map((item) => pullRequest(item, inputs.get("prs"))) ?? null;
	const issueItems = issues.items?.map((item) => issue(item, inputs.get("issues"))) ?? null;
	const ci = actions.items?.map((item) => action(item, inputs.get("actions"), repo)) ?? null;
	const deploy =
		ci?.filter((run) =>
			/\b(deploy|deployment|release|publish|pages)\b/i.test(
				`${run.workflow_name} ${run.path ?? ""}`,
			),
		) ?? null;
	const openPrs = prItems?.filter((item) => item.state === "open") ?? null;
	const openIssues = issueItems?.filter((item) => item.state === "open") ?? null;
	const classification = (prs.items ?? []).every(
		(item) =>
			item.dependency !== undefined ||
			labels(item, metadata(item, inputs.get("prs"))) !== null ||
			dependency(item, null),
	);
	const coverage: Record<string, ActivityCoverage> = {
		prs: prs.coverage,
		"prs.opened": prs.coverage,
		"prs.merged": prs.coverage,
		"prs.closed": prs.coverage,
		issues: issues.coverage,
		"issues.opened": issues.coverage,
		"issues.closed": issues.coverage,
		actions: actions.coverage,
		releases: releases.coverage,
		tags: unknownActivity("tags_not_collected"),
		commits: unknownActivity("owner_commit_attribution_unavailable"),
		other_commits: unknownActivity("owner_commit_attribution_unavailable"),
		default_branch:
			ci?.every((run) => run.is_default_branch !== null) && actions.coverage.status === "complete"
				? actions.coverage
				: unknownActivity("default_branch_unverified"),
		pr_classification: classification
			? prs.coverage
			: { ...prs.coverage, status: "partial", reason: "dependency_labels_unavailable" },
		"snapshot.open_prs": {
			...prs.coverage,
			status: openPrs === null ? "unavailable" : "partial",
			reason: "windowed_snapshot",
		},
		"snapshot.open_issues": {
			...issues.coverage,
			status: openIssues === null ? "unavailable" : "partial",
			reason: "windowed_snapshot",
		},
		security: unknownActivity("security_snapshot_unavailable"),
		run: { status: "partial", truncated: false, reason: "owner_commit_attribution_unavailable" },
	};
	return {
		repo: name,
		ci_runs: ci,
		prs: {
			opened: prItems?.filter((item) => inWindow(item.createdAt, window)) ?? null,
			merged: prItems?.filter((item) => inWindow(item.mergedAt, window)) ?? null,
			closed: prItems?.filter((item) => inWindow(item.closedAt, window)) ?? null,
		},
		issues: {
			opened: issueItems?.filter((item) => inWindow(item.createdAt, window)) ?? null,
			closed: issueItems?.filter((item) => inWindow(item.closedAt, window)) ?? null,
		},
		releases:
			releases.items?.filter((item) => item.state !== "draft" && inWindow(item.at, window)) ?? null,
		commits: { default: null, other: null, items: null },
		deploy: {
			runs: deploy,
			last_success_at:
				deploy
					?.filter((run) => run.conclusion === "success")
					.map((run) => run.updated_at ?? run.created_at)
					.filter((at): at is string => at !== null)
					.sort()
					.at(-1) ?? null,
		},
		snapshot: {
			open_prs: openPrs,
			open_issues:
				openIssues === null
					? null
					: {
							security: openIssues.filter((item) =>
								item.labels.some((label) => /security/i.test(label)),
							),
							dependency: openIssues.filter(
								(item) =>
									!item.labels.some((label) => /security/i.test(label)) &&
									dependency(item, item.labels),
							),
							other: openIssues.filter(
								(item) =>
									!item.labels.some((label) => /security/i.test(label)) &&
									!dependency(item, item.labels),
							),
						},
			dependabot: null,
			code_scanning: null,
		},
		coverage,
	};
}
