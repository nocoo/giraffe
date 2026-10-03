import { expect, it, vi } from "vitest";
import { WorkTransportError } from "./github.ts";
import {
	assertAllowedDependencyUpdate,
	discoverWorkTasks,
	readWorkTask,
	type WorkTask,
} from "./work-tasks.ts";

const repository = "owner/project";
const updatedAt = "2026-10-03T00:00:00Z";
const sha = "a".repeat(40);
const liveMain = { ref: "refs/heads/main", object: { type: "commit", sha: "e".repeat(40) } };
const issue = {
	name_with_owner: repository,
	number: 7,
	title: "Upgrade zod to 4.5.0",
	url: `https://github.com/${repository}/issues/7`,
	updated_at: updatedAt,
	labels: [],
};
const pull = {
	...issue,
	number: 8,
	title: "[CO] Fix parser",
	url: `https://github.com/${repository}/pull/8`,
	is_draft: false,
};
const stream = {
	repo: repository,
	workflow: "CI",
	branch: "main",
	scope: "main",
	verdict: "broken",
	streak: 2,
	recurring: false,
	recent: [
		{ id: 9, outcome: "failure", at: updatedAt },
		{ id: 6, outcome: "failure", at: "2026-10-02T00:00:00Z" },
	],
};
const dependencyTask: WorkTask = {
	id: "dependency:7",
	kind: "dependency",
	number: 7,
	title: issue.title,
	url: issue.url,
	updatedAt,
};
const prTask: WorkTask = {
	id: "pr:8",
	kind: "pr",
	number: 8,
	title: pull.title,
	url: pull.url,
	updatedAt,
};
const ciTask: WorkTask = {
	id: "ci:9",
	kind: "ci",
	number: 9,
	title: "Investigate CI",
	url: `https://github.com/${repository}/actions/runs/9`,
	updatedAt,
	workflow: "CI",
};
const currentIssue = { ...issue, html_url: issue.url, state: "open", body: "Update requested" };
const currentPull = {
	...pull,
	html_url: pull.url,
	state: "open",
	draft: false,
	head: { sha },
	base: { sha: "b".repeat(40), ref: "main", repo: { full_name: repository } },
	changed_files: 1,
};
const file = {
	filename: "src/parser.ts",
	status: "modified",
	additions: 1,
	deletions: 1,
	patch: "@@ -1 +1 @@\n-old\n+new",
};
const run = {
	id: 9,
	head_sha: sha,
	head_branch: "main",
	status: "completed",
	conclusion: "failure",
	workflow_id: 22,
	path: ".github/workflows/ci.yml",
	run_attempt: 2,
	repository: { full_name: repository, default_branch: "main" },
};
const job = {
	id: 90,
	run_id: 9,
	head_sha: sha,
	run_attempt: 2,
	name: "Unit tests",
	conclusion: "failure",
	steps: [{ number: 3, name: "Test", status: "completed", conclusion: "failure" }],
};

it("discovers namespaced original identities and deduplicates without conflating issues and PRs", () => {
	const tasks = discoverWorkTasks(repository, {
		issues: [issue, issue, { ...issue, number: 8, url: issue.url.replace("7", "8") }],
		prs: [pull, pull],
		streams: [stream, stream],
	});
	expect(tasks.map(({ id, number }) => [id, number])).toEqual([
		["dependency:7", 7],
		["dependency:8", 8],
		["pr:8", 8],
		["ci:9", 9],
	]);
	expect(tasks.every((task) => task.reason)).toBe(true);
});

it("requires explicit upgrade evidence and exact case-sensitive CO prefix", () => {
	expect(
		discoverWorkTasks(repository, {
			issues: [{ ...issue, title: "Upgrade dependencies", labels: [{ name: "dependencies" }] }],
			prs: [],
			streams: [],
		}),
	).toHaveLength(1);
	const accepted = [
		"Bump @scope/pkg from 1.0.0 to 2.0.0",
		"Update dependencies to latest stable releases",
		"Update dependency zod to 4.5.0",
		"依赖升级：zod",
		"升级依赖：zod",
		"chore(deps): upgrade vite to 8.3.2",
	];
	for (const title of accepted) {
		expect(
			discoverWorkTasks(repository, { issues: [{ ...issue, title }], prs: [], streams: [] }),
		).toHaveLength(1);
	}
	const rejected = [
		null,
		{ ...issue, title: "Dependency analysis" },
		{
			...issue,
			title: "Update documentation for dependency management",
			labels: [{ name: "dependencies" }],
		},
		{ ...issue, title: "Upgrade auth subsystem" },
		{ ...issue, title: "Dependency upgrade policy" },
		{ ...issue, title: "Upgrade dependencies policy", labels: [{ name: "dependencies" }] },
		{ ...issue, title: "Upgrade dependencies documentation", labels: [{ name: "dependencies" }] },
		{ ...issue, number: 0 },
		{ ...issue, number: 1.5 },
		{ ...issue, number: Number.MAX_SAFE_INTEGER + 1 },
		{ ...issue, name_with_owner: "other/project" },
		{ ...issue, url: "https://evil.test/issue" },
	];
	expect(
		discoverWorkTasks(repository, {
			issues: rejected,
			prs: [
				{ ...pull, title: "[co] Fix" },
				{ ...pull, title: " [CO] Fix" },
				{ ...pull, is_draft: true },
				{ ...pull, name_with_owner: "other/project" },
			],
			streams: [],
		}),
	).toEqual([]);
});

it("selects the latest failed main run only for consecutive or recurring investigations", () => {
	const recent = [{ id: 10, outcome: "success", at: "2026-10-04T00:00:00Z" }, ...stream.recent];
	const tasks = discoverWorkTasks(repository, {
		issues: [],
		prs: [],
		streams: [
			{ ...stream, streak: 0, recurring: true, verdict: "flaky", recent: [...recent].reverse() },
		],
	});
	expect(tasks[0]).toMatchObject({ id: "ci:9", number: 9, workflow: "CI", updatedAt });
	expect(tasks[0]?.reason).toMatch(/investigat/i);
	expect(
		discoverWorkTasks(repository, {
			issues: [],
			prs: [],
			streams: [
				{
					...stream,
					streak: 0,
					recurring: false,
					verdict: "broken",
					recent: [...recent, { id: 5, outcome: "success", at: "2026-10-01T00:00:00Z" }],
					decided: 4,
					failures: 2,
					brokenBy: "chronic",
				},
			],
		})[0],
	).toMatchObject({ id: "ci:9" });
	for (const extra of [
		{ streak: 1, recent: [stream.recent[0]] },
		{ scope: "bot" },
		{ scope: "branch" },
		{ branch: "feature" },
		{ repo: "other/project" },
		{ verdict: "healthy" },
		{ recent: [] },
		{ recent: [{ id: -1, outcome: "failure", at: updatedAt }] },
	])
		expect(
			discoverWorkTasks(repository, { issues: [], prs: [], streams: [{ ...stream, ...extra }] }),
		).toEqual([]);
});

it("ignores pending and cancelled outcomes when testing consecutive main failures", () => {
	const tasks = discoverWorkTasks(repository, {
		issues: [],
		prs: [],
		streams: [
			{
				...stream,
				pending: 1,
				decided: 2,
				failures: 2,
				brokenBy: "streak",
				recent: [
					{ id: 11, outcome: "pending", at: "2026-10-05T00:00:00Z" },
					{ id: 10, outcome: "other", at: "2026-10-04T00:00:00Z" },
					...stream.recent,
				],
			},
		],
	});
	expect(tasks[0]).toMatchObject({ id: "ci:9" });
	expect(tasks[0]?.reason).toMatch(/^Consecutive/);
});

it("wraps transport failures as safe retryable WorkTransportError", async () => {
	for (const failure of [new Error("secret-token"), new WorkTransportError("secret-token")]) {
		const result = readWorkTask(repository, dependencyTask, async () => {
			throw failure;
		});
		await expect(result).rejects.toBeInstanceOf(WorkTransportError);
		await expect(result).rejects.toThrow("GitHub read failed");
	}
});

it("reads only validated fixed paths and current dependency requests", async () => {
	const read = vi.fn(async () => currentIssue);
	expect(await readWorkTask(repository, dependencyTask, read)).toMatchObject({
		task: dependencyTask,
		evidence: { body: "Update requested", labels: [] },
	});
	expect(read).toHaveBeenCalledWith("repos/owner/project/issues/7");
	for (const value of [
		{ ...currentIssue, state: "closed" },
		{ ...currentIssue, pull_request: {} },
		{ ...currentIssue, updated_at: "changed" },
		{ ...currentIssue, title: "Not an upgrade" },
		{ ...currentIssue, html_url: "https://github.com/other/project/issues/7" },
		{ ...currentIssue, body: "x".repeat(300_000) },
	])
		await expect(readWorkTask(repository, dependencyTask, async () => value)).rejects.toThrow();
	for (const repo of ["../project", "owner/project/extra", "owner/..", "owner/project?x=1"]) {
		await expect(readWorkTask(repo, dependencyTask, read)).rejects.toThrow(/repository/i);
	}
	await expect(readWorkTask(repository, { ...dependencyTask, number: 0 }, read)).rejects.toThrow();
	await expect(readWorkTask(repository, { ...dependencyTask, id: "pr:7" }, read)).rejects.toThrow();
	await expect(
		readWorkTask(repository, dependencyTask, async () => {
			throw new Error("secret-token");
		}),
	).rejects.toThrow("GitHub read failed");
});

it("collects complete paginated PR patches and pins head and base after reading", async () => {
	const metadata = { ...currentPull, changed_files: 101 };
	const read = vi
		.fn()
		.mockResolvedValueOnce(metadata)
		.mockResolvedValueOnce(liveMain)
		.mockResolvedValueOnce(
			Array.from({ length: 100 }, (_, index) => ({ ...file, filename: `src/${index}.ts` })),
		)
		.mockResolvedValueOnce([{ ...file, filename: "src/100.ts" }])
		.mockResolvedValueOnce(metadata)
		.mockResolvedValueOnce(liveMain);
	const result = await readWorkTask(repository, prTask, read);
	expect(result.evidence).toMatchObject({
		head: currentPull.head,
		base: currentPull.base,
		liveBaseSha: liveMain.object.sha,
	});
	expect(result.evidence.files).toHaveLength(101);
	expect(read.mock.calls.map(([path]) => path)).toEqual([
		"repos/owner/project/pulls/8",
		"repos/owner/project/git/ref/heads/main",
		"repos/owner/project/pulls/8/files?per_page=100&page=1",
		"repos/owner/project/pulls/8/files?per_page=100&page=2",
		"repos/owner/project/pulls/8",
		"repos/owner/project/git/ref/heads/main",
	]);
});

it("rejects missing, incomplete, malformed, duplicate or oversized PR diffs", async () => {
	for (const files of [
		[],
		[{ ...file, patch: undefined }],
		[{ ...file, patch: "@@ -1 +1 @@\n-old" }],
		[{ ...file, additions: 2 }],
		[{ ...file, patch: "not a unified diff" }],
		[{ ...file, patch: "@@ -1 +1 @@\n-old\n+new\n+extra" }],
		[{ ...file, patch: "@@ -1,2 +1,2 @@\n-old\n+new\n@@ -4 +4 @@\n-old\n+new" }],
		[{ ...file, patch: "x".repeat(600_000) }],
		[file, file],
	]) {
		const read = vi
			.fn()
			.mockResolvedValueOnce(currentPull)
			.mockResolvedValueOnce(liveMain)
			.mockResolvedValueOnce(files);
		await expect(readWorkTask(repository, prTask, read)).rejects.toThrow(/manual|bound/i);
	}
	for (const extra of [
		{ changed_files: 301 },
		{ changed_files: 0 },
		{ draft: true },
		{ title: "[co] Fix" },
		{ state: "closed" },
		{ updated_at: "changed" },
	]) {
		await expect(
			readWorkTask(repository, prTask, async () => ({ ...currentPull, ...extra })),
		).rejects.toThrow();
	}
});

it("accepts complete multi-hunk patches with context and newline markers", async () => {
	const patch =
		"@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n\\ No newline at end of file\n@@ -4 +4 @@\n-before\n+after\n";
	const read = vi
		.fn()
		.mockResolvedValueOnce(currentPull)
		.mockResolvedValueOnce(liveMain)
		.mockResolvedValueOnce([{ ...file, additions: 2, deletions: 2, patch }])
		.mockResolvedValueOnce(currentPull)
		.mockResolvedValueOnce(liveMain);
	expect((await readWorkTask(repository, prTask, read)).evidence.files).toHaveLength(1);
});

it("rejects unverifiable evidence and aggregate PR size without truncation", async () => {
	for (const value of [undefined, { ...currentIssue, body: 1n }]) {
		await expect(readWorkTask(repository, dependencyTask, async () => value)).rejects.toThrow(
			/manual/,
		);
	}
	const largeFile = {
		...file,
		additions: 1,
		deletions: 1,
		patch: `@@ -1 +1 @@\n-${"a".repeat(70_000)}\n+${"b".repeat(70_000)}`,
	};
	const read = vi
		.fn()
		.mockResolvedValueOnce({ ...currentPull, changed_files: 2 })
		.mockResolvedValueOnce(liveMain)
		.mockResolvedValueOnce([largeFile, { ...largeFile, filename: "second.ts" }]);
	await expect(readWorkTask(repository, prTask, read)).rejects.toThrow(/bound/);
});

it("rejects a PR revision or eligibility change during file reads", async () => {
	for (const extra of [
		{ head: { sha: "c".repeat(40) } },
		{ base: { ...currentPull.base, sha: "d".repeat(40) } },
		{ changed_files: 2 },
		{ updated_at: "changed" },
		{ draft: true },
	]) {
		const read = vi
			.fn()
			.mockResolvedValueOnce(currentPull)
			.mockResolvedValueOnce(liveMain)
			.mockResolvedValueOnce([file])
			.mockResolvedValueOnce({ ...currentPull, ...extra });
		await expect(readWorkTask(repository, prTask, read)).rejects.toThrow();
	}
});

it("rejects live main ref changes and explicitly flags pure-renames unsupported", async () => {
	const changed = vi
		.fn()
		.mockResolvedValueOnce(currentPull)
		.mockResolvedValueOnce(liveMain)
		.mockResolvedValueOnce([file])
		.mockResolvedValueOnce(currentPull)
		.mockResolvedValueOnce({ ...liveMain, object: { type: "commit", sha: "f".repeat(40) } });
	await expect(readWorkTask(repository, prTask, changed)).rejects.toThrow(/main.*changed/i);
	const rename = vi
		.fn()
		.mockResolvedValueOnce(currentPull)
		.mockResolvedValueOnce(liveMain)
		.mockResolvedValueOnce([
			{ ...file, status: "renamed", additions: 0, deletions: 0, patch: undefined },
		]);
	await expect(readWorkTask(repository, prTask, rename)).rejects.toThrow(/unsupported.*manual/i);
});

it("captures exact failed CI run and job identities without claiming a flaky cause", async () => {
	const read = vi
		.fn()
		.mockResolvedValueOnce(run)
		.mockResolvedValueOnce({ total_count: 1, jobs: [job] });
	const result = await readWorkTask(repository, ciTask, read);
	expect(result.evidence).toMatchObject({
		head_sha: sha,
		workflow_id: 22,
		path: run.path,
		run_attempt: 2,
		failedJobs: [job],
		diagnostics: "available",
	});
	expect(read.mock.calls.map(([path]) => path)).toEqual([
		"repos/owner/project/actions/runs/9",
		"repos/owner/project/actions/runs/9/jobs?per_page=100",
	]);
	const missing = vi
		.fn()
		.mockResolvedValueOnce(run)
		.mockResolvedValueOnce({ total_count: 0, jobs: [] });
	expect((await readWorkTask(repository, ciTask, missing)).evidence).toMatchObject({
		diagnostics: "missing",
		failedJobs: [],
	});
});

it("rejects nonfailure, wrong main lane, changed run/job identity and partial diagnostics", async () => {
	for (const extra of [
		{ id: 10 },
		{ head_sha: "short" },
		{ status: "in_progress" },
		{ conclusion: "success" },
		{ conclusion: "cancelled" },
		{ head_branch: "feature" },
		{ repository: { full_name: "other/project", default_branch: "main" } },
		{ repository: { full_name: repository, default_branch: "develop" } },
	])
		await expect(
			readWorkTask(repository, ciTask, async () => ({ ...run, ...extra })),
		).rejects.toThrow();
	for (const value of [
		{ total_count: 2, jobs: [job] },
		{ total_count: 101, jobs: [] },
		{ total_count: 1, jobs: [{ ...job, run_id: 10 }] },
		{ total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
		{ total_count: 1, jobs: [{ ...job, run_attempt: 1 }] },
	]) {
		const read = vi.fn().mockResolvedValueOnce(run).mockResolvedValueOnce(value);
		await expect(readWorkTask(repository, ciTask, read)).rejects.toThrow();
	}
});

it("permits stable upgrades except explicit critical majors and rejects unverifiable versions", () => {
	for (const after of ["1.0.1", "1.1.0", "2.0.0"])
		expect(() => assertAllowedDependencyUpdate("pkg", "1.0.0", after, [])).not.toThrow();
	expect(() => assertAllowedDependencyUpdate("pkg", "1.0.0", "1.1.0", ["pkg"])).not.toThrow();
	for (const [name, before, after, critical] of [
		["pkg", "1.0.0", "2.0.0", ["pkg"]],
		["pkg", "2.0.0", "1.0.0", []],
		["pkg", "1.0.0", "2.0.0-beta.1", []],
		["pkg", "invalid", "2.0.0", []],
		["pkg", "^1.0.0", "2.0.0", []],
		["pkg", "1.0.0", "latest", []],
		["../pkg", "1.0.0", "1.1.0", []],
	] as const)
		expect(() => assertAllowedDependencyUpdate(name, before, after, critical)).toThrow();
});
