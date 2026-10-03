import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubRead } from "./github.ts";
import { latestPackage } from "./work-packages.ts";
import { reviewWork } from "./work-review.ts";
import { verifyWorkIssues, workerActions } from "./work-tools.ts";

vi.mock("./github.ts", () => ({ githubRead: vi.fn() }));
vi.mock("./work-packages.ts", () => ({ latestPackage: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("commits actual worker review corrections without duplicate task completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-review-tools-"));
	let head = "base";
	const driver = {
		check: vi.fn(async () => {}),
		commit: vi.fn(async () => {
			head = `${head}-commit`;
			return head;
		}),
	};
	const worker = workerActions(driver as never, { path: directory, status: "" } as never, [1]);
	const state = { round: 0, findings: [] as string[], head: null as string | null };
	try {
		await writeFile(join(directory, "code.ts"), "old");
		const approved = await reviewWork({
			load: async () => state,
			save: async (value) => Object.assign(state, value),
			fix: async (round) => {
				await worker.action("write", { path: "code.ts", content: `round ${round}` });
				await worker.action("commit", { issues: [1], files: ["code.ts"], message: "fix: cause" });
			},
			check: async () => {
				await driver.check();
				return head;
			},
			review: async (checked, round) => ({
				head: checked,
				findings: round === 1 ? ["fix actual cause"] : [],
			}),
		});
		expect(approved).toBe("base-commit-commit");
		expect(worker.committed).toEqual([{ issue: 1, head: approved }]);
		expect(driver.commit).toHaveBeenCalledTimes(2);
		expect(await readFile(join(directory, "code.ts"), "utf8")).toBe("round 2");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("gives workers a read-only latest-version lookup using the configured mirror", async () => {
	vi.mocked(latestPackage).mockResolvedValue({
		name: "demo",
		version: "2.0.0",
		registry: "https://mirrors.tencent.com/npm/",
		verifiedAt: "now",
	});
	const driver = { packageRegistry: "https://mirrors.tencent.com/npm/" };
	const worker = workerActions(driver as never, { status: "" } as never, [1]);
	expect(await worker.action("latest", { name: "demo" })).toMatchObject({ version: "2.0.0" });
	expect(latestPackage).toHaveBeenCalledWith("demo", driver.packageRegistry);
});

it("verifies already-current issues without manufacturing commits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-current-"));
	const driver = {
		packageRegistry: "https://mirrors.tencent.com/npm/",
		check: vi.fn(),
		inspect: vi.fn(async () => ({ head: "existing", status: "", diff: "" })),
	};
	const worker = workerActions(
		driver as never,
		{ path: directory, status: "", diff: "", manager: "bun" } as never,
		[1],
	);
	vi.mocked(latestPackage).mockResolvedValue({
		name: "jsdom",
		version: "30.1.1",
		registry: driver.packageRegistry,
		verifiedAt: "now",
	});
	try {
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ devDependencies: { jsdom: "30.1.1" } }),
		);
		await writeFile(join(directory, "bun.lock"), '"jsdom": ["jsdom@30.1.1", "", {}]');
		await expect(worker.action("satisfied", { issue: 2, name: "jsdom" })).rejects.toThrow(/next/);
		driver.inspect.mockResolvedValueOnce({
			head: "existing",
			status: " M package.json",
			diff: "change",
		});
		await expect(worker.action("satisfied", { issue: 1, name: "jsdom" })).rejects.toThrow(
			/pending/,
		);
		await writeFile(join(directory, "bun.lock"), "old lock");
		await expect(worker.action("satisfied", { issue: 1, name: "jsdom" })).rejects.toThrow(/exact/);
		await writeFile(join(directory, "bun.lock"), '"jsdom": ["jsdom@30.1.1", "", {}]');
		expect(await worker.action("satisfied", { issue: 1, name: "jsdom" })).toMatchObject({
			alreadyCurrent: true,
			head: "existing",
		});
		expect(worker.committed).toEqual([{ issue: 1, head: "existing" }]);
		expect(driver.check).toHaveBeenCalledOnce();
		const npmWorker = workerActions(
			driver as never,
			{ path: directory, status: "", diff: "", manager: "npm" } as never,
			[2],
		);
		await writeFile(
			join(directory, "package-lock.json"),
			JSON.stringify({ packages: { "node_modules/jsdom": { version: "30.1.1" } } }),
		);
		expect(await npmWorker.action("satisfied", { issue: 2, name: "jsdom" })).toMatchObject({
			alreadyCurrent: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("revalidates owner, main and every issue before native execution", async () => {
	const identity = { login: "owner" };
	const repo = {
		full_name: "owner/repo",
		owner: identity,
		fork: false,
		archived: false,
		default_branch: "main",
	};
	const issue = {
		number: 1,
		title: "fix",
		url: "https://github.com/owner/repo/issues/1",
		updatedAt: "now",
	};
	const live = { number: 1, state: "open", title: "fix", body: "details", updated_at: "now" };
	const setup = (metadata = repo, current = live, user = identity) =>
		vi
			.mocked(githubRead)
			.mockResolvedValueOnce(user)
			.mockResolvedValueOnce(metadata)
			.mockResolvedValueOnce(current);
	setup();
	expect(await verifyWorkIssues("owner/repo", [issue])).toEqual([{ ...issue, body: "details" }]);
	setup(repo, { ...live, title: "ordinary PR", pull_request: {} } as never);
	await expect(verifyWorkIssues("owner/repo", [{ ...issue, kind: "pr" }])).rejects.toThrow(
		"changed",
	);
	setup(repo, { ...live, title: "[CO] fix", pull_request: {} } as never);
	await expect(verifyWorkIssues("owner/repo", [{ ...issue, kind: "pr" }])).resolves.toHaveLength(1);
	for (const metadata of [
		{ ...repo, fork: true },
		{ ...repo, archived: true },
		{ ...repo, default_branch: "dev" },
		{ ...repo, full_name: "wrong" },
		{ ...repo, owner: { login: "other" } },
	]) {
		vi.mocked(githubRead).mockReset();
		setup(metadata);
		await expect(verifyWorkIssues("owner/repo", [issue])).rejects.toThrow(/scope/);
	}
	vi.mocked(githubRead).mockReset();
	setup(repo, live, { login: "other" });
	await expect(verifyWorkIssues("owner/repo", [issue])).rejects.toThrow(/scope/);
	for (const current of [
		{ ...live, state: "closed" },
		{ ...live, number: 2 },
		{ ...live, updated_at: "new" },
		{ ...live, pull_request: {} },
	]) {
		vi.mocked(githubRead).mockReset();
		setup(repo, current);
		await expect(verifyWorkIssues("owner/repo", [issue])).rejects.toThrow(/changed/);
	}
});

it("restricts worker IO, preserves dirty files and commits checked issues in order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-work-tools-"));
	const driver = {
		check: vi.fn(async () => {}),
		commit: vi.fn(async () => "head"),
		install: vi.fn(async () => {}),
		inspect: vi.fn(async () => ({ status: " M bun.lock\n M package-lock.json\n M unrelated" })),
	};
	const workspace = { path: directory, status: ' M dirty.ts\n?? "other.ts"' };
	const controller = new AbortController();
	const worker = workerActions(driver as never, workspace as never, [1, 2, 3], controller.signal);
	try {
		await writeFile(join(directory, "code.ts"), "old");
		expect(await worker.action("read", { path: "code.ts" })).toEqual({ content: "old" });
		await writeFile(join(directory, "window.txt"), `${"x".repeat(20000)}needle details`);
		expect(await worker.action("read", { path: "window.txt" })).toMatchObject({
			nextOffset: 16000,
			total: 20014,
		});
		expect(await worker.action("read", { path: "window.txt", match: "needle" })).toMatchObject({
			content: expect.stringContaining("needle details"),
		});
		await expect(worker.action("read", { path: "window.txt", match: "absent" })).rejects.toThrow(
			/not found/,
		);
		for (const path of [
			"",
			"/tmp/file",
			"../file",
			".git/config",
			".env",
			"node_modules/key",
			"config.json",
			"dirty.ts",
			"other.ts",
			".husky/pre-commit",
			"AGENTS.md",
			".github/test",
		])
			await expect(worker.action("write", { path, content: "bad" })).rejects.toThrow();
		await symlink("/tmp", join(directory, "escape"));
		await expect(worker.action("write", { path: "escape/file", content: "bad" })).rejects.toThrow(
			/escaped/,
		);
		await symlink(join(directory, "code.ts"), join(directory, "linked"));
		await expect(worker.action("read", { path: "linked" })).rejects.toThrow(/Symlink/);
		await mkdir(join(directory, "src"));
		await worker.action("write", { path: "src/new.ts", content: "new" });
		await worker.action("write", { path: "code.ts", content: "fixed" });
		expect(await readFile(join(directory, "code.ts"), "utf8")).toBe("fixed");
		await expect(
			worker.action("commit", { issues: [2], files: ["code.ts"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await expect(
			worker.action("commit", { issues: [1], files: ["unowned"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await worker.action("check", {});
		await worker.action("install", {});
		expect(driver.install).toHaveBeenCalled();
		for (const issues of [
			[1, 1],
			[1, 99],
		])
			await expect(
				worker.action("commit", { issues, files: ["code.ts"], message: "fix: bug" }),
			).rejects.toThrow(/next/);
		await worker.action("commit", { issues: [1, 3], files: ["code.ts"], message: "fix: bug" });
		expect(worker.committed).toEqual([
			{ issue: 1, head: "head" },
			{ issue: 3, head: "head" },
		]);
		expect(driver.check).toHaveBeenCalledTimes(2);
		await worker.action("write", { path: "code.ts", content: "fixed again" });
		await worker.action("commit", { issues: [2], files: ["code.ts"], message: "fix: next" });
		expect(worker.committed.at(-1)?.issue).toBe(2);
		await worker.action("write", { path: "code.ts", content: "review correction" });
		await worker.action("commit", { issues: [1], files: ["code.ts"], message: "fix: review" });
		await worker.action("write", { path: "code.ts", content: "second task correction" });
		await worker.action("commit", { issues: [2], files: ["code.ts"], message: "fix: second" });
		expect(worker.committed).toHaveLength(3);
		await expect(worker.action("push", {})).rejects.toThrow(/permitted/);
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ scripts: { test: "test" }, dependencies: {} }),
		);
		await expect(
			worker.action("write", { path: "package.json", content: JSON.stringify({ scripts: {} }) }),
		).rejects.toThrow(/scripts/);
		await worker.action("write", {
			path: "package.json",
			content: JSON.stringify({ scripts: { test: "test" }, dependencies: { dep: "2" } }),
		});
		await writeFile(
			join(directory, "biome.jsonc"),
			'{"$schema":"https://biomejs.dev/schemas/2.5.14/schema.json","linter":{"enabled":true}}',
		);
		await worker.action("write", {
			path: "biome.jsonc",
			content:
				'{"$schema":"https://biomejs.dev/schemas/2.5.15/schema.json","linter":{"enabled":true}}',
		});
		await expect(
			worker.action("write", {
				path: "biome.jsonc",
				content:
					'{"$schema":"https://biomejs.dev/schemas/2.5.15/schema.json","linter":{"enabled":false}}',
			}),
		).rejects.toThrow(/weaken/);
		await writeFile(join(directory, "large"), "x".repeat(256001));
		await expect(worker.action("read", { path: "large" })).rejects.toThrow(/budget/);
		controller.abort();
		await expect(worker.action("read", { path: "code.ts" })).rejects.toThrow(/cancelled/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
