import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalCommand } from "./repair-local.ts";
import { WorkWorkspace } from "./work-workspace.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "giraffe-main-test-")));
	directories.push(root);
	const path = join(root, "repo");
	await mkdir(join(path, ".husky"), { recursive: true });
	await writeFile(join(path, "AGENTS.md"), "Keep hooks and tests.");
	await writeFile(
		join(path, "package.json"),
		JSON.stringify({
			scripts: {
				"test:coverage": "vitest run --coverage",
				lint: "biome check .",
				typecheck: "tsc",
			},
		}),
	);
	await writeFile(join(path, "bun.lock"), "lock");
	await writeFile(join(path, "code.ts"), "code");
	for (const hook of ["pre-commit", "pre-push"]) {
		await writeFile(join(path, ".husky", hook), "#!/bin/sh\nexit 0\n");
		await chmod(join(path, ".husky", hook), 0o755);
	}
	const state = {
		branch: "main",
		head: "head",
		status: "",
		diff: "",
		counts: "2 0",
		origin: "git@github.com:owner/repo.git",
		hooks: ".husky",
		remote: "head",
		top: path,
		fail: "",
		tracked: "code.ts\npackage.json\nAGENTS.md\nbun.lock",
		afterCheck: () => {},
		afterInstall: () => {},
	};
	const calls: LocalCommand[] = [];
	const run = vi.fn(async (request: LocalCommand) => {
		calls.push(request);
		const args = request.args.join(" ");
		if (args === state.fail) return { exitCode: 1, stdout: "", stderr: "do not leak" };
		if (request.args[0] === "run") state.afterCheck();
		if (request.args[0] === "install") state.afterInstall();
		if (args === "switch main") state.branch = "main";
		if (args.startsWith("commit -m")) {
			state.head = "committed";
			state.status = "";
			state.diff = "";
		}
		const output =
			args === "rev-parse --show-toplevel"
				? state.top
				: args === "remote get-url origin"
					? state.origin
					: args === "branch --show-current"
						? state.branch
						: args === "rev-parse HEAD"
							? state.head
							: args.startsWith("status ")
								? state.status
								: args === "ls-files"
									? state.tracked
									: args.startsWith("diff HEAD")
										? state.diff
										: args.startsWith("rev-list")
											? state.counts
											: args === "config --get core.hooksPath"
												? state.hooks
												: args.startsWith("ls-remote")
													? `${state.remote}\trefs/heads/main`
													: "";
		return { exitCode: 0, stdout: `${output}\n`, stderr: "" };
	});
	return { root, path, state, calls, run, driver: new WorkWorkspace({ root, run }) };
}

it("inspects native main without mutating, preserves ahead commits and identifies npm checks", async () => {
	const { driver, path, calls } = await fixture();
	const inspection = await driver.inspect("owner/repo");
	expect(await driver.files(inspection)).toContain("package.json");
	expect(driver.packageRegistry).toContain("packagefeedproxy");
	expect(inspection).toMatchObject({
		path,
		branch: "main",
		ahead: 2,
		behind: 0,
		status: "",
		manager: "bun",
		checks: ["test:coverage", "lint", "typecheck"],
	});
	expect(
		calls.every((call) => call.command === "git" && call.env?.GIT_OPTIONAL_LOCKS === "0"),
	).toBe(true);
	await rm(join(path, "bun.lock"));
	await writeFile(
		join(path, "package.json"),
		JSON.stringify({ scripts: { test: "vitest", lint: "biome" } }),
	);
	expect(await driver.inspect("owner/repo")).toMatchObject({
		manager: "npm",
		checks: ["test", "lint"],
	});
});

it("blocks wrong origins, roots, symlinks, missing gates and unsafe dirty evidence", async () => {
	const { driver, root, path, state } = await fixture();
	await expect(driver.inspect("owner/..")).rejects.toThrow(/Unsafe/);
	state.origin = "https://github.com/other/repo.git";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/origin/);
	state.origin = "https://github.com/owner/repo";
	state.top = root;
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/independent/);
	state.top = path;
	state.counts = "bad";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/tracking/);
	state.counts = "0 0";
	state.status = " M .env";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/credential/);
	state.status = " M code.ts";
	state.diff = "x".repeat(128001);
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/budget/);
	state.diff = "-----BEGIN PRIVATE KEY-----";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/credential/);
	state.diff = "diff";
	state.status = '?? "new file.ts"';
	await writeFile(join(path, "new file.ts"), "untracked code");
	expect((await driver.inspect("owner/repo")).diff).toContain("untracked code");
	await symlink(join(path, "code.ts"), join(path, "link"));
	state.status = "?? link";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/symlink/);
	state.status = "";
	state.hooks = "../hooks";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/hooks/);
	state.hooks = ".husky";
	await writeFile(join(path, "package.json"), JSON.stringify({ scripts: { lint: "lint" } }));
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/unit-test/);
	await symlink(path, join(root, "alias"));
	await expect(driver.inspect("owner/alias")).rejects.toThrow(/symlink/);
});

it("prepares with fast-forward, temporary mirror and baseline tests without losing local work", async () => {
	const { driver, state, calls } = await fixture();
	state.branch = "feature";
	const initial = await driver.inspect("owner/repo");
	expect((await driver.prepare(initial, false)).branch).toBe("main");
	expect(calls.map((call) => call.args.join(" "))).toContain("pull --ff-only origin main");
	expect(calls.filter((call) => call.command === "bun").map((call) => call.args.join(" "))).toEqual(
		["install --frozen-lockfile", "run test:coverage", "run lint", "run typecheck"],
	);
	expect(calls.find((call) => call.command === "bun")?.env?.BUN_CONFIG_REGISTRY).toContain(
		"packagefeedproxy",
	);
	state.status = " M code.ts";
	state.diff = "user";
	const dirty = await driver.inspect("owner/repo");
	await expect(driver.prepare(dirty, false)).rejects.toThrow(/Dirty/);
	calls.length = 0;
	await driver.prepare(dirty, true);
	expect(calls.some((call) => call.args[0] === "pull")).toBe(false);
	state.counts = "0 1";
	await expect(driver.prepare(await driver.inspect("owner/repo"), true)).rejects.toThrow(/Dirty/);
	state.counts = "0 0";
	state.branch = "feature";
	await expect(driver.prepare(await driver.inspect("owner/repo"), true)).rejects.toThrow(/Dirty/);
});

it("blocks changed baseline, failed checks and install mutations", async () => {
	const { driver, state, path } = await fixture();
	const initial = await driver.inspect("owner/repo");
	state.head = "other";
	await expect(driver.prepare(initial, false)).rejects.toThrow(/changed/);
	state.head = "head";
	state.fail = "run lint";
	await expect(driver.check(initial)).rejects.toThrow(/failed/);
	state.fail = "";
	state.afterInstall = () => {
		state.status = " M bun.lock";
		state.diff = "changed lock";
	};
	await expect(driver.prepare(initial, false)).rejects.toThrow(/modified files/);
	state.status = "";
	state.diff = "";
	await writeFile(join(path, "AGENTS.md"), "changed instructions");
	await expect(driver.check(initial)).rejects.toThrow(/Baseline/);
});

it("stages only owned files, keeps hooks and refuses dirty baseline/staged/unsafe files", async () => {
	const { driver, state, calls } = await fixture();
	const initial = await driver.inspect("owner/repo");
	state.status = " M code.ts";
	expect(await driver.commit(initial, ["code.ts"], "fix: issue")).toBe("committed");
	expect(calls.map((call) => call.args.join(" "))).toContain("add -- code.ts");
	expect(calls.some((call) => call.args.includes("--no-verify"))).toBe(false);
	state.status = " M code.ts";
	await expect(
		driver.commit(await driver.inspect("owner/repo"), ["code.ts"], "fix: issue"),
	).rejects.toThrow(/preserve/);
	await expect(driver.commit(initial, ["../secret"], "fix: issue")).rejects.toThrow(/preserve/);
	await expect(driver.commit(initial, [], "fix: issue")).rejects.toThrow(/preserve/);
	state.status = "M  code.ts";
	await expect(driver.commit(initial, ["code.ts"], "fix: issue")).rejects.toThrow(/staged/);
	state.status = "";
	state.branch = "feature";
	await expect(driver.commit(initial, ["code.ts"], "fix: issue")).rejects.toThrow(/main/);
});

it("verifies checks and remote HEAD before issue closure, retaining only approved dirt", async () => {
	const { driver, state, calls } = await fixture();
	state.status = " M code.ts";
	state.diff = "retained";
	const initial = await driver.inspect("owner/repo");
	await driver.publish(initial, "head", [1, 2]);
	const mutations = calls.filter((call) =>
		["push", "ls-remote", "issue"].includes(call.args[0] ?? ""),
	);
	expect(mutations.map((call) => call.args.join(" "))).toEqual([
		"push origin HEAD:main",
		"ls-remote origin refs/heads/main",
		"issue close 1 --repo owner/repo",
		"issue close 2 --repo owner/repo",
	]);
	await expect(driver.publish(initial, "wrong", [1])).rejects.toThrow(/Publication/);
	await expect(driver.publish(initial, "head", [])).rejects.toThrow(/scope/);
	await expect(driver.publish(initial, "head", [-1])).rejects.toThrow(/scope/);
	state.remote = "other";
	await expect(driver.publish(initial, "head", [1])).rejects.toThrow(/Remote/);
	state.afterCheck = () => {
		state.head = "racing";
	};
	await expect(driver.publish(initial, "head", [1])).rejects.toThrow(/Publication/);
});

it("pins tracked gates, blocks symlink commits and detects a remote advance over dirty work", async () => {
	const { driver, path, state, run } = await fixture();
	await writeFile(join(path, "vitest.config.ts"), "thresholds=95");
	await symlink(join(path, "code.ts"), join(path, "eslint.config.js"));
	state.tracked += "\n.husky/pre-commit\nvitest.config.ts\neslint.config.js";
	const initial = await driver.inspect("owner/repo");
	await expect(driver.commit(initial, ["eslint.config.js"], "fix: issue")).rejects.toThrow(
		/Unsafe/,
	);
	await writeFile(join(path, "vitest.config.ts"), "thresholds=0");
	await expect(driver.check(initial)).rejects.toThrow(/Baseline/);
	await writeFile(join(path, "vitest.config.ts"), "thresholds=95");
	state.status = " M code.ts";
	state.diff = "approved";
	const dirty = await driver.inspect("owner/repo");
	const original = run.getMockImplementation() as NonNullable<
		ReturnType<typeof run.getMockImplementation>
	>;
	run.mockImplementation(async (request) => {
		if (request.args[0] === "fetch") state.counts = "0 1";
		return original(request);
	});
	await expect(driver.prepare(dirty, true)).rejects.toThrow(/Remote advanced/);
});

it("handles npm installation and read-only cancellation failures explicitly", async () => {
	const { driver, path, calls, state } = await fixture();
	await rm(join(path, "bun.lock"));
	const inspection = await driver.inspect("owner/repo");
	await driver.install(inspection, new AbortController().signal);
	expect(
		calls.some(
			(call) => call.command === "npm" && call.args.join(" ") === "install --no-audit --no-fund",
		),
	).toBe(true);
	state.tracked = "";
	expect((await driver.inspect("owner/repo")).diff).toBe("");
	state.hooks = "";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/hooks/);
	state.hooks = "/tmp/hooks";
	await expect(driver.inspect("owner/repo")).rejects.toThrow(/hooks/);
});

it("logs sanitized native results and includes the build gate when present", async () => {
	const { root, path, run, state } = await fixture();
	await writeFile(
		join(path, "package.json"),
		JSON.stringify({ scripts: { "test:unit:coverage": "vitest", lint: "lint", build: "build" } }),
	);
	const log = vi.fn();
	const driver = new WorkWorkspace({ root, run, log });
	const inspection = await driver.inspect("owner/repo");
	expect(inspection.checks).toEqual(["test:unit:coverage", "lint", "build"]);
	await driver.check(inspection);
	expect(log).toHaveBeenCalledWith(expect.stringContaining("run build"));
	state.fail = "run lint";
	await expect(driver.check(inspection)).rejects.toThrow(/failed/);
	expect(log).toHaveBeenCalledWith(expect.stringContaining("exit=1"));
});
