import { gt, lt, major, prerelease, valid } from "semver";
import { z } from "zod";
import { WorkTransportError } from "./github.ts";

export type WorkTask = {
	id: string;
	kind: "dependency" | "pr" | "ci";
	number: number;
	title: string;
	url: string;
	updatedAt: string;
	workflow?: string;
	reason?: string;
};

const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const labels = z.array(z.object({ name: z.string() })).max(100);
const failure = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const maxBytes = 256 * 1024;
const maxFiles = 300;
const observed = z.object({
	name_with_owner: z.string(),
	number: identity,
	title: z.string().max(1000),
	url: z.string(),
	updated_at: timestamp,
	labels: labels.optional().default([]),
	is_draft: z.boolean().optional(),
});
const ciStream = z.object({
	repo: z.string(),
	workflow: z.string().min(1).max(1000),
	branch: z.string(),
	scope: z.enum(["main", "branch", "bot"]),
	verdict: z.string(),
	streak: z.number().int().nonnegative(),
	recurring: z.boolean(),
	recent: z.array(z.object({ id: identity, outcome: z.string(), at: timestamp })).max(100),
});

function assertRepository(repository: string) {
	if (
		!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
		[".", ".."].includes(repository.split("/")[1] ?? "")
	)
		throw new Error("Invalid repository; use an exact owner/repository name.");
}

function dependencyRequest(title: string, tags: { name: string }[]) {
	if (/\b(?:policy|documentation|docs|discussion)\b|政策|文档|讨论/i.test(title)) return false;
	if (/依赖升级|升级依赖/.test(title)) return true;
	const version = /\b(?:to|from)\s+v?\d+\.\d+(?:\.\d+)?\b/i;
	const named =
		/\b(?:upgrade|bump|update)\s+(?:(?:dependency|package)\s+)?(?:@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)\s+(?:to|from)\s+/i;
	const dependencies =
		/\b(?:upgrade|bump|update)\s+(?:(?:all|npm|bun|package)\s+)?dependencies\s+(?:to|from)\s+(?:latest|stable|v?\d)/i;
	return (
		(named.test(title) && version.test(title)) ||
		dependencies.test(title) ||
		(tags.some(({ name }) => name.toLowerCase() === "dependencies") &&
			((/\b(?:upgrade|bump|update)\b/i.test(title) && version.test(title)) ||
				/^(?:upgrade|bump|update)\s+(?:dependencies|packages)(?:\s|$)/i.test(title)))
	);
}

function taskUrl(repository: string, kind: WorkTask["kind"], number: number) {
	const lane = kind === "dependency" ? "issues" : kind === "pr" ? "pull" : "actions/runs";
	return `https://github.com/${repository}/${lane}/${number}`;
}

export function discoverWorkTasks(
	repository: string,
	data: { issues: unknown[]; prs: unknown[]; streams: unknown[] },
): WorkTask[] {
	assertRepository(repository);
	const tasks = new Map<string, WorkTask>();
	for (const kind of ["dependency", "pr"] as const) {
		for (const value of kind === "dependency" ? data.issues : data.prs) {
			const parsed = observed.safeParse(value);
			if (!parsed.success) continue;
			const item = parsed.data;
			if (
				item.name_with_owner !== repository ||
				item.url !== taskUrl(repository, kind, item.number)
			)
				continue;
			if (
				kind === "dependency"
					? !dependencyRequest(item.title, item.labels)
					: !item.title.startsWith("[CO]") || item.is_draft !== false
			)
				continue;
			const id = `${kind}:${item.number}`;
			tasks.set(id, {
				id,
				kind,
				number: item.number,
				title: item.title,
				url: item.url,
				updatedAt: item.updated_at,
				reason:
					kind === "dependency"
						? "Explicit dependency upgrade request."
						: "Exact [CO] non-draft pull request.",
			});
		}
	}
	for (const value of data.streams) {
		const parsed = ciStream.safeParse(value);
		if (!parsed.success) continue;
		const stream = parsed.data;
		if (
			stream.repo !== repository ||
			stream.scope !== "main" ||
			stream.branch !== "main" ||
			!["broken", "flaky"].includes(stream.verdict)
		)
			continue;
		const recent = [...stream.recent].sort(
			(left, right) => Date.parse(right.at) - Date.parse(left.at),
		);
		const decisive = recent.filter((run) => run.outcome === "failure" || run.outcome === "success");
		const failures = decisive.filter((run) => run.outcome === "failure");
		const consecutive =
			stream.streak >= 2 &&
			decisive[0]?.outcome === "failure" &&
			decisive[1]?.outcome === "failure";
		const chronic =
			stream.verdict === "broken" &&
			decisive.length >= 4 &&
			failures.length / decisive.length >= 0.5;
		if (!consecutive && !chronic && !(stream.recurring && failures.length >= 2)) continue;
		const run = failures[0];
		if (!run) continue;
		const id = `ci:${run.id}`;
		tasks.set(id, {
			id,
			kind: "ci",
			number: run.id,
			title: `Investigate ${stream.workflow}`,
			url: taskUrl(repository, "ci", run.id),
			updatedAt: run.at,
			workflow: stream.workflow,
			reason: `${consecutive ? "Consecutive" : "Recurring"} main workflow failures require investigation; cause is unconfirmed.`,
		});
	}
	return [...tasks.values()];
}

const currentIssue = z.object({
	number: identity,
	title: z.string().max(1000),
	html_url: z.string(),
	updated_at: timestamp,
	state: z.literal("open"),
	body: z.string().nullable(),
	labels,
	pull_request: z.unknown().optional(),
});
const currentPull = z.object({
	number: identity,
	title: z.string().max(1000),
	html_url: z.string(),
	updated_at: timestamp,
	state: z.literal("open"),
	draft: z.literal(false),
	head: z.object({ sha }),
	base: z.object({ sha, ref: z.literal("main"), repo: z.object({ full_name: z.string() }) }),
	changed_files: identity.max(maxFiles),
});
const pullFile = z.object({
	filename: z.string().min(1).max(4096),
	status: z.string(),
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	patch: z.string().min(1),
});

function assertCompletePatch(file: z.infer<typeof pullFile>) {
	let additions = 0;
	let deletions = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	let hunks = 0;
	for (const line of file.patch.replace(/\n$/, "").split("\n")) {
		const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (header) {
			if (oldRemaining || newRemaining) throw new Error("PR diff incomplete; needs manual review.");
			oldRemaining = Number(header[1] ?? 1);
			newRemaining = Number(header[2] ?? 1);
			hunks++;
		} else if (line.startsWith("+")) {
			additions++;
			newRemaining--;
		} else if (line.startsWith("-")) {
			deletions++;
			oldRemaining--;
		} else if (line.startsWith(" ")) {
			oldRemaining--;
			newRemaining--;
		} else if (line !== "\\ No newline at end of file")
			throw new Error("PR diff malformed; needs manual review.");
		if (oldRemaining < 0 || newRemaining < 0)
			throw new Error("PR diff malformed; needs manual review.");
	}
	if (
		!hunks ||
		oldRemaining ||
		newRemaining ||
		additions !== file.additions ||
		deletions !== file.deletions
	)
		throw new Error("PR diff incomplete; needs manual review.");
}

const ciRun = z.object({
	id: identity,
	head_sha: sha,
	head_branch: z.literal("main"),
	status: z.literal("completed"),
	conclusion: z.string(),
	workflow_id: identity,
	path: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
	run_attempt: identity,
	repository: z.object({ full_name: z.string(), default_branch: z.literal("main") }),
});
const ciJob = z.object({
	id: identity,
	run_id: identity,
	head_sha: sha,
	run_attempt: identity,
	name: z.string(),
	conclusion: z.string().nullable(),
	steps: z
		.array(
			z.object({
				number: identity,
				name: z.string(),
				status: z.string(),
				conclusion: z.string().nullable(),
			}),
		)
		.max(1000)
		.optional()
		.default([]),
});

export async function readWorkTask(
	repository: string,
	task: WorkTask,
	read: (path: string) => Promise<unknown>,
): Promise<{ task: WorkTask; evidence: Record<string, unknown> }> {
	assertRepository(repository);
	if (
		!identity.safeParse(task.number).success ||
		!["dependency", "pr", "ci"].includes(task.kind) ||
		task.id !== `${task.kind}:${task.number}` ||
		task.url !== taskUrl(repository, task.kind, task.number)
	)
		throw new Error("Invalid task identity; rediscover the task.");
	const root = `repos/${repository}`;
	async function get(path: string) {
		let value: unknown;
		try {
			value = await read(path);
		} catch {
			throw new WorkTransportError("GitHub read failed; retry the fixed task read.");
		}
		assertBound(value);
		return value;
	}
	function parse<Value>(schema: z.ZodType<Value>, value: unknown): Value {
		const result = schema.safeParse(value);
		if (!result.success)
			throw new Error("Task evidence invalid or missing; needs manual investigation.");
		return result.data;
	}
	function assertCurrent(value: { number: number; html_url: string; updated_at: string }) {
		if (
			value.number !== task.number ||
			value.html_url !== task.url ||
			value.updated_at !== task.updatedAt
		)
			throw new Error("Task changed; rediscover before investigation.");
	}
	let evidence: Record<string, unknown>;
	if (task.kind === "dependency") {
		const issue = parse(currentIssue, await get(`${root}/issues/${task.number}`));
		assertCurrent(issue);
		if (issue.pull_request !== undefined || !dependencyRequest(issue.title, issue.labels))
			throw new Error("Issue is not a current dependency upgrade request.");
		evidence = issue;
	} else if (task.kind === "pr") {
		const path = `${root}/pulls/${task.number}`;
		const pull = parse(currentPull, await get(path));
		assertCurrent(pull);
		if (!pull.title.startsWith("[CO]") || pull.base.repo.full_name !== repository)
			throw new Error("PR must be an exact [CO] request targeting this repository main.");
		const mainPath = `${root}/git/ref/heads/main`;
		const mainRef = z.object({
			ref: z.literal("refs/heads/main"),
			object: z.object({ type: z.literal("commit"), sha }),
		});
		const liveBaseSha = parse(mainRef, await get(mainPath)).object.sha;
		const files: z.infer<typeof pullFile>[] = [];
		for (let page = 1; page <= Math.ceil(pull.changed_files / 100); page++) {
			const rawBatch = await get(`${path}/files?per_page=100&page=${page}`);
			if (
				Array.isArray(rawBatch) &&
				rawBatch.some((file: unknown) => {
					const rename = z
						.object({ status: z.literal("renamed"), patch: z.string().optional() })
						.safeParse(file);
					return rename.success && !rename.data.patch;
				})
			)
				throw new Error("Pure rename without a content patch is unsupported; needs manual review.");
			const batch = parse(z.array(pullFile).max(100), rawBatch);
			for (const file of batch) assertCompletePatch(file);
			files.push(...batch);
			assertBound(files);
		}
		if (
			files.length !== pull.changed_files ||
			new Set(files.map((file) => file.filename)).size !== files.length
		)
			throw new Error("PR files incomplete; needs manual review.");
		const current = parse(currentPull, await get(path));
		assertCurrent(current);
		if (JSON.stringify(current) !== JSON.stringify(pull))
			throw new Error("PR revision changed; retry review.");
		if (parse(mainRef, await get(mainPath)).object.sha !== liveBaseSha)
			throw new Error("Live main revision changed; retry review.");
		evidence = { ...pull, liveBaseSha, files };
	} else {
		const run = parse(ciRun, await get(`${root}/actions/runs/${task.number}`));
		if (
			run.id !== task.number ||
			run.repository.full_name !== repository ||
			!failure.has(run.conclusion)
		)
			throw new Error("CI evidence must identify this terminal failed main run.");
		const jobs = parse(
			z.object({
				total_count: z.number().int().nonnegative().max(100),
				jobs: z.array(ciJob).max(100),
			}),
			await get(`${root}/actions/runs/${task.number}/jobs?per_page=100`),
		);
		if (
			jobs.total_count !== jobs.jobs.length ||
			new Set(jobs.jobs.map((job) => job.id)).size !== jobs.jobs.length ||
			jobs.jobs.some(
				(job) =>
					job.run_id !== run.id ||
					job.head_sha !== run.head_sha ||
					job.run_attempt !== run.run_attempt,
			)
		)
			throw new Error(
				"CI job evidence incomplete or revision changed; needs manual investigation.",
			);
		const failedJobs = jobs.jobs.filter(
			(job) => job.conclusion !== null && failure.has(job.conclusion),
		);
		evidence = {
			...run,
			failedJobs,
			diagnostics: failedJobs.some((job) =>
				job.steps.some((step) => step.conclusion !== null && failure.has(step.conclusion)),
			)
				? "available"
				: "missing",
		};
	}
	assertBound(evidence);
	return { task, evidence };
}

function assertBound(value: unknown) {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("Evidence cannot be verified; needs manual investigation.");
	}
	if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes)
		throw new Error("Evidence exceeds bounded read size; needs manual investigation.");
}

export function assertAllowedDependencyUpdate(
	name: string,
	before: string,
	after: string,
	criticalPackages: readonly string[],
): void {
	if (
		!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name) ||
		!valid(before) ||
		!valid(after) ||
		prerelease(after) ||
		lt(after, before)
	)
		throw new Error("Dependency update requires verified stable versions without downgrades.");
	if (criticalPackages.includes(name) && gt(after, before) && major(after) > major(before))
		throw new Error("Critical package major upgrade requires manual approval.");
}
