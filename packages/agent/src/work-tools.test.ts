import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubRead } from "./repair-source.ts";
import { verifyWorkIssues, workerActions } from "./work-tools.ts";

vi.mock("./repair-source.ts", () => ({ githubRead: vi.fn() }));
afterEach(() => vi.resetAllMocks());

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
	const worker = workerActions(driver as never, workspace as never, [1, 2], controller.signal);
	try {
		await writeFile(join(directory, "code.ts"), "old");
		expect(await worker.action("read", { path: "code.ts" })).toEqual({ content: "old" });
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
			worker.action("commit", { issue: 2, files: ["code.ts"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await expect(
			worker.action("commit", { issue: 1, files: ["unowned"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await worker.action("check", {});
		await worker.action("install", {});
		expect(driver.install).toHaveBeenCalled();
		await worker.action("commit", { issue: 1, files: ["code.ts"], message: "fix: bug" });
		expect(worker.committed).toEqual([{ issue: 1, head: "head" }]);
		expect(driver.check).toHaveBeenCalledTimes(2);
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
		await writeFile(join(directory, "large"), "x".repeat(256001));
		await expect(worker.action("read", { path: "large" })).rejects.toThrow(/budget/);
		controller.abort();
		await expect(worker.action("read", { path: "code.ts" })).rejects.toThrow(/cancelled/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
