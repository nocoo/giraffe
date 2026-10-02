import { execFileSync } from "node:child_process";
import {
	chmod,
	cp,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { hostGitTransport, LocalCleanupError, type LocalRunner, runLocal } from "./repair-local.ts";
import {
	type HostGitTransport,
	type RepairProfile,
	WorkspaceDriver,
	WorkspaceError,
} from "./repair-workspace.ts";

vi.setConfig({ testTimeout: 20000 });
const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH,
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_ALLOW_PROTOCOL: "file",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	}).trim();
const manifest = (version = "1.0.0") =>
	JSON.stringify({
		name: "fixture",
		scripts: { test: "node test.cjs" },
		dependencies: { demo: version },
	});
async function fixture(options: { run?: LocalRunner; transport?: HostGitTransport } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "repair-native-")));
	roots.push(root);
	const source = join(root, "source");
	await mkdir(source);
	git(source, "init", "-b", "main");
	await writeFile(join(source, "package.json"), manifest());
	await writeFile(join(source, "package-lock.json"), "{}\n");
	await writeFile(join(source, "AGENTS.md"), "Checks: npm run test\n");
	await writeFile(join(source, "test.cjs"), "console.log('local-check-passed')\n");
	await writeFile(join(source, ".gitignore"), "node_modules/\n.husky/_/\nhook-result\n");
	await mkdir(join(source, ".hooks"));
	await writeFile(
		join(source, ".hooks/pre-commit"),
		"#!/bin/sh\nprintf pre-commit >> hook-result\n",
		{ mode: 0o755 },
	);
	await writeFile(
		join(source, ".hooks/pre-push"),
		"#!/bin/sh\ncat >/dev/null\nprintf pre-push >> hook-result\n",
		{ mode: 0o755 },
	);
	git(
		source,
		"add",
		"package.json",
		"package-lock.json",
		"AGENTS.md",
		"test.cjs",
		".gitignore",
		".hooks/pre-commit",
		".hooks/pre-push",
	);
	git(source, "commit", "-m", "fixture");
	const baseSha = git(source, "rev-parse", "HEAD");
	const profile = {
		manager: "npm" as const,
		files: ["package.json", "package-lock.json", "src/fix.ts"],
		checks: ["test"],
		hooksPath: ".hooks",
	};
	const driver = new WorkspaceDriver({
		root: join(root, "workspaces"),
		profiles: { "fixture/repo": profile },
		localSources: { "fixture/repo": source },
		...(options.run ? { run: options.run } : {}),
		...(options.transport ? { gitTransport: options.transport } : {}),
	});
	const workspace = await driver.prepare({
		id: "deps-issue-1",
		repository: "fixture/repo",
		baseSha,
		defaultBranch: "main",
	});
	return { root, source, driver, workspace, baseSha, profile };
}
const runner = () =>
	vi.fn<LocalRunner>(async (request) =>
		request.command === "git"
			? { exitCode: 0, stdout: git(request.cwd, ...request.args), stderr: "" }
			: { exitCode: 0, stdout: "local test passed", stderr: "" },
	);
async function prepared() {
	const run = runner();
	const f = await fixture({ run });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed\n");
	const snapshot = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
	});
	return {
		...f,
		run,
		snapshot,
		checks,
		commit: {
			contentFingerprint: snapshot.contentFingerprint,
			files: snapshot.changedPaths,
			message: "fix: update fixture",
			checks,
		},
	};
}
const proofFor = (
	snapshot: { head: string; contentFingerprint: string },
	checks: Awaited<ReturnType<WorkspaceDriver["check"]>>,
) => ({
	head: snapshot.head,
	contentFingerprint: snapshot.contentFingerprint,
	checks,
	signoff: {
		head: snapshot.head,
		contentFingerprint: snapshot.contentFingerprint,
		validationDigest: checks.validationDigest,
	},
});

it("runs actual local npm checks with no runner configuration and preserves the original checkout", async () => {
	const f = await fixture();
	const snapshot = await f.driver.snapshot(f.workspace);
	const receipt = await f.driver.check(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
	});
	expect(receipt.results[0]?.stdout).toContain("local-check-passed");
	expect(f.workspace.branch).toBe("giraffe/deps-issue-1");
	await f.driver.writeFile(f.workspace, "package.json", manifest("2.0.0"));
	const changed = await f.driver.snapshot(f.workspace);
	expect(changed.changedPaths).toEqual(["package.json"]);
	expect(changed.contentFingerprint).not.toBe(snapshot.contentFingerprint);
	expect(changed.manifestBeforeAfter["package.json"]?.before).toContain("1.0.0");
	expect(await readFile(join(f.source, "package.json"), "utf8")).toContain("1.0.0");
});
it("performs native commit and push hooks in the working clone with exact signoff and idempotent retry", async () => {
	const run = runner();
	let remote = "";
	let remotePath = "";
	const transport: HostGitTransport = async (request) => {
		expect(request.command.args).not.toContain("--force");
		expect(request.command.args).not.toContain("--no-verify");
		if (request.operation === "remoteHead")
			return {
				exitCode: 0,
				stdout: remote ? `${remote}\trefs/heads/giraffe/deps-issue-1` : "",
				stderr: "",
			};
		expect(git(request.cwd, "rev-parse", "--is-bare-repository")).toBe("false");
		git(request.cwd, "push", remotePath, request.command.args.at(-1) as string);
		remote = request.command.args.at(-1)?.split(":")[0] ?? "";
		return { exitCode: 0, stdout: "pushed", stderr: "" };
	};
	const f = await fixture({ run, transport });
	remotePath = join(f.root, "remote.git");
	git(f.root, "init", "--bare", "-b", "main", remotePath);
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed\n");
	const snapshot = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
	});
	const committed = await f.driver.commit(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
		files: snapshot.changedPaths,
		message: "fix",
		checks,
	});
	expect(committed.contentFingerprint).toBe(snapshot.contentFingerprint);
	const proof = {
		head: committed.head,
		contentFingerprint: committed.contentFingerprint,
		checks,
		signoff: {
			head: committed.head,
			contentFingerprint: committed.contentFingerprint,
			validationDigest: checks.validationDigest,
		},
	};
	expect(await f.driver.push(f.workspace, proof)).toMatchObject({ reconciled: false });
	expect(await readFile(join(f.workspace.path, "hook-result"), "utf8")).toBe("pre-commitpre-push");
	expect(await f.driver.push(f.workspace, proof)).toMatchObject({ reconciled: true });
	remote = "a".repeat(40);
	await expect(f.driver.push(f.workspace, proof)).rejects.toThrow(/differs/);
	await expect(f.driver.push(f.workspace, { ...proof, head: f.baseSha })).rejects.toThrow(
		/signoff/,
	);
	await expect(
		f.driver.push(f.workspace, { ...proof, signal: AbortSignal.abort() }),
	).rejects.toThrow(/cancelled/);
});
it("retains a full diff but does not reject ordinary tracked templates, symlinks or attributes", async () => {
	const f = await fixture();
	await writeFile(join(f.source, ".env.example"), "PLACEHOLDER=\n");
	await writeFile(join(f.source, ".gitattributes"), "*.ts text eol=lf\n");
	await symlink("test.cjs", join(f.source, "test-link"));
	git(f.source, "add", ".env.example", ".gitattributes", "test-link");
	git(f.source, "commit", "-m", "templates");
	const ws = await f.driver.prepare({
		id: "deps-templates",
		repository: f.workspace.repository,
		defaultBranch: "main",
		baseSha: git(f.source, "rev-parse", "HEAD"),
	});
	expect((await f.driver.snapshot(ws)).changedPaths).toEqual([]);
	await expect(f.driver.readFile(ws, ".env.example")).rejects.toThrow(/Unsafe/);
});
it("rejects unsafe model file writes and unreviewed changes without claiming an OS boundary", async () => {
	const f = await fixture();
	for (const path of [
		"../outside",
		"/tmp/outside",
		".git/config",
		".env",
		"nested/.env.local",
		".npmrc",
		"unknown.ts",
		".hooks/pre-commit",
		"AGENTS.md",
	]) {
		await expect(f.driver.writeFile(f.workspace, path, "bad")).rejects.toThrow();
	}
	await expect(f.driver.readFile(f.workspace, "unknown.ts")).rejects.toThrow(/allowlist/);
	await expect(
		f.driver.writeFile(f.workspace, "package.json", '{"scripts":{"test":"true"}}'),
	).rejects.toThrow(/scripts/);
	await symlink(f.root, join(f.workspace.path, "src"));
	await expect(f.driver.writeFile(f.workspace, "src/fix.ts", "bad")).rejects.toThrow(/symlink/);
	await rm(join(f.workspace.path, "src"));
	await f.driver.writeFile(f.workspace, "src/fix.ts", "new");
	git(f.workspace.path, "add", "src/fix.ts");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/index/);
});
it("validates complete check proofs, unchanged scripts and stale code before commit", async () => {
	const f = await prepared();
	await expect(f.driver.check(f.workspace, { contentFingerprint: "stale" })).rejects.toThrow(
		/Stale/,
	);
	await expect(
		f.driver.check(f.workspace, {
			contentFingerprint: f.snapshot.contentFingerprint,
			commands: ["unchecked"],
		}),
	).rejects.toThrow(/configured/);
	await expect(
		f.driver.commit(f.workspace, { ...f.commit, checks: { ...f.checks } }),
	).rejects.toThrow(/Checks/);
	await expect(f.driver.commit(f.workspace, { ...f.commit, files: [] })).rejects.toThrow(
		/explicitly/,
	);
	await expect(
		f.driver.commit(f.workspace, { ...f.commit, message: "line\nbreak" }),
	).rejects.toThrow(/explicitly/);
	const next = await f.driver.check(f.workspace, {
		contentFingerprint: f.snapshot.contentFingerprint,
	});
	expect(next.validationDigest).toBe(f.checks.validationDigest);
	await f.driver.writeFile(f.workspace, "src/fix.ts", "different");
	await expect(f.driver.commit(f.workspace, f.commit)).rejects.toThrow(/Stale/);
});
it("restores only task-owned staging after a failed commit and can replay successful commits", async () => {
	const f = await prepared();
	f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "commit failed" });
	await expect(f.driver.commit(f.workspace, f.commit)).rejects.toThrow(/Local command/);
	expect(git(f.workspace.path, "diff", "--cached", "--name-only")).toBe("");
	expect(await f.driver.readFile(f.workspace, "src/fix.ts")).toBe("fixed\n");
	const committed = await f.driver.commit(f.workspace, f.commit);
	expect(await f.driver.commit(f.workspace, f.commit)).toEqual(committed);
	expect(f.run.mock.calls.filter(([req]) => req.command === "git")).toHaveLength(2);
});
it("reopens persisted workspaces and reconciles interrupted owned commit staging", async () => {
	const f = await prepared();
	await writeFile(
		join(f.root, "workspaces", `${f.workspace.id}.commit.json`),
		JSON.stringify({
			beforeHead: f.snapshot.head,
			contentFingerprint: f.snapshot.contentFingerprint,
			files: f.snapshot.changedPaths,
		}),
	);
	git(f.workspace.path, "add", "src/fix.ts");
	const next = new WorkspaceDriver({
		root: f.driver.root,
		profiles: { "fixture/repo": f.profile },
		localSources: { "fixture/repo": f.source },
		run: f.run,
	});
	const ws = await next.prepare({
		id: f.workspace.id,
		repository: f.workspace.repository,
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	expect(git(ws.path, "diff", "--cached", "--name-only")).toBe("");
	expect((await next.snapshot(ws)).contentFingerprint).toBe(f.snapshot.contentFingerprint);
	await expect(
		next.prepare({
			id: ws.id,
			repository: ws.repository,
			baseSha: "c".repeat(40),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/identity/);
});
it("performs scripts-enabled installs with a per-command registry and rolls back failed upgrades", async () => {
	const run = runner();
	const f = await fixture({ run });
	run.mockImplementation(async (request) => {
		expect(request.args).not.toContain("--offline");
		expect(request.args).not.toContain("--ignore-scripts");
		expect(request.env?.npm_config_registry).toBe("https://mirrors.tencent.com/npm/");
		await writeFile(join(request.cwd, "package-lock.json"), '{"updated":true}\n');
		return { exitCode: 0, stdout: "installed", stderr: "" };
	});
	const input = {
		manifest: "package.json",
		section: "dependencies" as const,
		name: "demo",
		version: "2.0.0",
	};
	const updated = await f.driver.updateDependency(f.workspace, input);
	expect(updated.changedPaths).toEqual(["package-lock.json", "package.json"]);
	expect((await f.driver.updateDependency(f.workspace, input)).contentFingerprint).toBe(
		updated.contentFingerprint,
	);
	run.mockResolvedValueOnce({ exitCode: 2, stdout: "npm ERR! dependency missing", stderr: "" });
	const before = await f.driver.readFile(f.workspace, "package.json");
	await expect(f.driver.updateDependency(f.workspace, input)).rejects.toThrow(/Local command/);
	expect(await f.driver.readFile(f.workspace, "package.json")).toBe(before);
});
it("executes real generated Husky hooks and refuses inactive wrappers", async () => {
	const f = await fixture();
	await mkdir(join(f.source, ".husky"));
	await writeFile(
		join(f.source, ".husky/pre-commit"),
		"printf pre-commit >> hook-result\ntest ! -e .git/block-commit\n",
	);
	await writeFile(
		join(f.source, ".husky/pre-push"),
		"cat >.git/push-input\nprintf pre-push >> hook-result\ntest ! -e .git/block-push\n",
	);
	git(f.source, "add", ".husky/pre-commit", ".husky/pre-push");
	git(f.source, "commit", "-m", "husky");
	const run = runner();
	run.mockImplementation(async (request) => {
		if (request.args[0] === "install") {
			await cp(
				dirname(fileURLToPath(import.meta.resolve("husky"))),
				join(request.cwd, "node_modules/husky"),
				{ recursive: true },
			);
			await writeFile(join(request.cwd, "package-lock.json"), '{"updated":true}');
			return runLocal({
				...request,
				command: process.execPath,
				args: [join(request.cwd, "node_modules/husky/bin.js")],
				env: { ...request.env, HOME: f.root },
			});
		}
		return runLocal({
			...request,
			env: {
				...request.env,
				HOME: f.root,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			},
		});
	});
	const remote = join(f.root, "husky-remote.git");
	git(f.root, "init", "--bare", "-b", "main", remote);
	const driver = new WorkspaceDriver({
		root: join(f.root, "husky-work"),
		profiles: { "fixture/repo": { ...f.profile, hooksPath: ".husky/_" } },
		localSources: { "fixture/repo": f.source },
		run,
		gitTransport: (request) =>
			hostGitTransport({
				...request,
				command: {
					command: "git",
					args: request.command.args.map((value) =>
						value === "https://github.com/fixture/repo.git" ? remote : value,
					),
				},
			}),
	});
	const ws = await driver.prepare({
		id: "deps-husky",
		repository: "fixture/repo",
		baseSha: git(f.source, "rev-parse", "HEAD"),
		defaultBranch: "main",
	});
	await driver.updateDependency(ws, {
		manifest: "package.json",
		section: "dependencies",
		name: "demo",
		version: "2.0.0",
	});
	const snap = await driver.snapshot(ws);
	const checks = await driver.check(ws, { contentFingerprint: snap.contentFingerprint });
	const args = {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix: fixture",
		checks,
	};
	await writeFile(join(ws.path, ".git/block-commit"), "");
	await expect(driver.commit(ws, args)).rejects.toThrow(/Local command/);
	expect(git(ws.path, "diff", "--cached", "--name-only")).toBe("");
	await rm(join(ws.path, ".git/block-commit"));
	const committed = await driver.commit(ws, args);
	git(ws.path, "remote", "set-url", "origin", remote);
	const proof = {
		head: committed.head,
		contentFingerprint: committed.contentFingerprint,
		checks,
		signoff: {
			head: committed.head,
			contentFingerprint: committed.contentFingerprint,
			validationDigest: checks.validationDigest,
		},
	};
	await writeFile(join(ws.path, ".git/block-push"), "");
	await expect(driver.push(ws, proof)).rejects.toThrow(/transport/);
	expect(git(f.root, "ls-remote", remote)).toBe("");
	await rm(join(ws.path, ".git/block-push"));
	expect(await driver.push(ws, proof)).toMatchObject({ reconciled: false });
	expect(await readFile(join(ws.path, "hook-result"), "utf8")).toBe(
		"pre-commitpre-commitpre-pushpre-push",
	);
	expect(await readFile(join(ws.path, ".git/push-input"), "utf8")).toContain(
		`${committed.head} refs/heads/${ws.branch}`,
	);
	await writeFile(join(ws.path, ".husky/_/pre-commit"), "#!/bin/sh\nexit 0\n");
	await expect(
		driver.check(ws, { contentFingerprint: committed.contentFingerprint }),
	).rejects.toThrow(/Husky/);
});
it("cancels dependency installation and preserves the exact retry input", async () => {
	const run = runner();
	const f = await fixture({ run });
	const controller = new AbortController();
	run.mockImplementationOnce(async (request) => {
		expect(request.signal).toBe(controller.signal);
		await writeFile(join(request.cwd, "package-lock.json"), "partial");
		controller.abort();
		return { exitCode: 1, stdout: "", stderr: "aborted" };
	});
	const input = {
		manifest: "package.json",
		section: "dependencies" as const,
		name: "demo",
		version: "2.0.0",
		signal: controller.signal,
	};
	await expect(f.driver.updateDependency(f.workspace, input)).rejects.toThrow(/cancelled/);
	expect(await f.driver.readFile(f.workspace, "package.json")).toBe(manifest());
	expect(await f.driver.readFile(f.workspace, "package-lock.json")).toBe("{}\n");
	expect(
		(
			await f.driver.updateDependency(f.workspace, {
				...input,
				signal: new AbortController().signal,
			})
		).changedPaths,
	).toEqual(["package.json"]);
});
it("reports bounded safe native diagnostics and rejects cancelled or changed checks", async () => {
	const f = await prepared();
	f.run.mockResolvedValueOnce({
		exitCode: 1,
		stdout: "TS2322: fix the import",
		stderr: "Authorization: Bearer private-token",
	});
	try {
		await f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint });
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceError);
		expect((error as WorkspaceError).details).toContain("TS2322");
		expect((error as WorkspaceError).details).not.toContain("private-token");
	}
	await expect(
		f.driver.check(f.workspace, {
			contentFingerprint: f.snapshot.contentFingerprint,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow(/cancelled/);
	f.run.mockImplementationOnce(async () => {
		await f.driver.writeFile(f.workspace, "src/fix.ts", "mutated");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint }),
	).rejects.toThrow(/changed/);
});
it("refuses invalid identities, missing profile and incomplete or unsafe diff contents", async () => {
	const f = await fixture();
	for (const change of [
		{ id: "../main" },
		{ repository: "https://evil/repo" },
		{ baseSha: "bad" },
		{ defaultBranch: "--bad" },
	])
		await expect(
			f.driver.prepare({
				id: "deps-new",
				repository: "fixture/repo",
				baseSha: f.baseSha,
				defaultBranch: "main",
				...change,
			}),
		).rejects.toThrow();
	const empty = new WorkspaceDriver({ root: join(f.root, "empty"), profiles: {} });
	await expect(
		empty.prepare({
			id: "deps-test",
			repository: "fixture/repo",
			baseSha: f.baseSha,
			defaultBranch: "main",
		}),
	).rejects.toThrow(/profile/);
	await expect(
		f.driver.readFile({ ...f.workspace, branch: "main" }, "package.json"),
	).rejects.toThrow(/identity/);
	await f.driver.writeFile(f.workspace, "src/fix.ts", "x".repeat(45000));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/40 KiB/);
	await rm(join(f.workspace.path, "src"), { recursive: true });
	await writeFile(join(f.workspace.path, "package.json"), Buffer.from([0, 1]));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/binary/);
});
it("requires unchanged active hooks rather than silently bypassing local checks", async () => {
	const f = await prepared();
	git(f.workspace.path, "config", "core.hooksPath", ".elsewhere");
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint }),
	).rejects.toThrow(/hooks/);
	git(f.workspace.path, "config", "core.hooksPath", ".hooks");
	await writeFile(join(f.workspace.path, ".hooks/pre-commit"), "#!/bin/sh\nexit 1\n");
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint }),
	).rejects.toThrow(/allowlist/);
	await writeFile(
		join(f.workspace.path, ".hooks/pre-commit"),
		"#!/bin/sh\nprintf pre-commit >> hook-result\n",
	);
	await chmod(join(f.workspace.path, ".hooks/pre-commit"), 0o644);
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint }),
	).rejects.toThrow(/allowlist/);
});

it("refuses changed bases, default branches, invalid profiles and replaced workspace paths", async () => {
	const f = await fixture();
	const input = {
		id: "deps-next",
		repository: "fixture/repo",
		baseSha: f.baseSha,
		defaultBranch: "main",
	};
	await expect(f.driver.prepare({ ...input, baseSha: "a".repeat(40) })).rejects.toThrow(/SHA/);
	await expect(f.driver.prepare({ ...input, defaultBranch: "giraffe/deps-next" })).rejects.toThrow(
		/Default/,
	);
	for (const patch of [{ checks: ["bad script"] }, { files: [".env"] }, { hooksPath: "" }]) {
		const driver = new WorkspaceDriver({
			root: join(f.root, "invalid"),
			profiles: { "fixture/repo": { ...f.profile, ...patch } },
		});
		await expect(driver.prepare(input)).rejects.toThrow();
	}
	await symlink(f.driver.root, join(f.root, "alias"));
	const alias = new WorkspaceDriver({
		root: join(f.root, "alias"),
		profiles: { "fixture/repo": f.profile },
	});
	await expect(alias.prepare(input)).rejects.toThrow(/symlink/);
	git(f.workspace.path, "checkout", "-b", "other");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/branch/);
	git(f.workspace.path, "checkout", f.workspace.branch);
	await rename(f.workspace.path, `${f.workspace.path}-old`);
	await symlink(`${f.workspace.path}-old`, f.workspace.path);
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/symlink/);
});
it("rejects unsafe file types, ignored review inputs, oversized writes and preserves deletions", async () => {
	const f = await fixture();
	await expect(f.driver.writeFile(f.workspace, "src/fix.ts", "\0")).rejects.toThrow(/binary/);
	await expect(f.driver.writeFile(f.workspace, "src/fix.ts", "x".repeat(270000))).rejects.toThrow(
		/limit/,
	);
	await mkdir(join(f.workspace.path, "src/fix.ts"), { recursive: true });
	await expect(f.driver.writeFile(f.workspace, "src/fix.ts", "x")).rejects.toThrow(/Unsafe file/);
	await expect(f.driver.readFile(f.workspace, "src/fix.ts")).rejects.toThrow(/regular/);
	await rm(join(f.workspace.path, "src/fix.ts"), { recursive: true });
	await writeFile(join(f.root, "hard"), "x");
	await link(join(f.root, "hard"), join(f.workspace.path, "src/fix.ts"));
	await expect(f.driver.readFile(f.workspace, "src/fix.ts")).rejects.toThrow(/regular/);
	await expect(f.driver.writeFile(f.workspace, "src/fix.ts", "x")).rejects.toThrow(/Unsafe file/);
	await rm(join(f.workspace.path, "src/fix.ts"));
	await mkdir(join(f.workspace.path, ".git/info"), { recursive: true });
	await writeFile(join(f.workspace.path, ".git/info/exclude"), "src/fix.ts\n");
	await writeFile(join(f.workspace.path, "src/fix.ts"), "ignored");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/ignored/);
	await rm(join(f.workspace.path, "src/fix.ts"));
	await rm(join(f.workspace.path, "package.json"));
	expect(
		(await f.driver.snapshot(f.workspace)).manifestBeforeAfter["package.json"]?.after,
	).toBeNull();
	await writeFile(join(f.workspace.path, "package.json"), "x".repeat(270000));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/limit/);
});
it("rejects ambiguous commit intents and leaves unrelated index and head changes untouched", async () => {
	const f = await prepared();
	const marker = join(f.driver.root, `${f.workspace.id}.commit.json`);
	const intent = {
		beforeHead: f.snapshot.head,
		contentFingerprint: f.snapshot.contentFingerprint,
		files: f.snapshot.changedPaths,
	};
	await writeFile(marker, JSON.stringify({ ...intent, files: [".git/config"] }));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/Invalid commit intent/);
	await writeFile(marker, JSON.stringify({ ...intent, contentFingerprint: "wrong" }));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/intent content/);
	await writeFile(marker, JSON.stringify(intent));
	expect((await f.driver.snapshot(f.workspace)).contentFingerprint).toBe(
		f.snapshot.contentFingerprint,
	);
	await f.driver.writeFile(f.workspace, "src/fix.ts", "different staged bytes");
	git(f.workspace.path, "add", "src/fix.ts");
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed\n");
	await writeFile(marker, JSON.stringify(intent));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/staged content/);
	git(f.workspace.path, "restore", "--staged", "--", "src/fix.ts");
	await f.driver.snapshot(f.workspace);
	git(f.workspace.path, "add", "src/fix.ts");
	git(f.workspace.path, "commit", "-m", "intended");
	git(f.workspace.path, "commit", "--allow-empty", "-m", "unrelated");
	await writeFile(marker, JSON.stringify(intent));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/head mismatch/);
	expect(git(f.workspace.path, "log", "-1", "--format=%s")).toBe("unrelated");
});
it("rejects non-root dependency plans, baseline policy weakening and replay drift", async () => {
	const run = runner();
	const f = await fixture({ run });
	const input = {
		manifest: "package.json",
		section: "dependencies" as const,
		name: "demo",
		version: "2.0.0",
	};
	for (const patch of [
		{ manifest: "nested/package.json" },
		{ version: "https://evil" },
		{ name: "missing" },
	])
		await expect(f.driver.updateDependency(f.workspace, { ...input, ...patch })).rejects.toThrow();
	await writeFile(join(f.workspace.path, "package.json"), '{"scripts":{"test":"true"}}');
	let snapshot = await f.driver.snapshot(f.workspace);
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow(/scripts/);
	await f.driver.writeFile(f.workspace, "package.json", manifest());
	await f.driver.writeFile(f.workspace, "src/fix.ts", "unrelated");
	await expect(f.driver.updateDependency(f.workspace, input)).rejects.toThrow(/replay/);
	await rm(join(f.workspace.path, "src/fix.ts"));
	const original = JSON.parse(manifest());
	original.optionalDependencies = { demo: "2.0.0" };
	await f.driver.writeFile(f.workspace, "package.json", JSON.stringify(original));
	await expect(
		f.driver.updateDependency(f.workspace, { ...input, section: "optionalDependencies" }),
	).rejects.toThrow(/baseline/);
	await f.driver.writeFile(f.workspace, "package.json", manifest());
	run.mockImplementationOnce(async () => {
		await f.driver.writeFile(f.workspace, "src/fix.ts", "side effect");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(f.driver.updateDependency(f.workspace, input)).rejects.toThrow(/unexpected files/);
	expect(await f.driver.readFile(f.workspace, "package.json")).toBe(manifest());
	await rm(join(f.workspace.path, "src/fix.ts"));
	snapshot = await f.driver.snapshot(f.workspace);
	expect(snapshot.changedPaths).toEqual([]);
});
it("supports Bun and custom registry while requiring tracked checks, lockfile and hook activation", async () => {
	const f = await fixture();
	await writeFile(join(f.source, "bun.lock"), "{}\n");
	git(f.source, "add", "bun.lock");
	git(f.source, "commit", "-m", "bun fixture");
	const run = runner();
	const driverFor = (name: string, patch: Partial<RepairProfile>) =>
		new WorkspaceDriver({
			root: join(f.root, name),
			profiles: { "fixture/repo": { ...f.profile, ...patch } },
			localSources: { "fixture/repo": f.source },
			run,
			registry: "https://mirror.example.invalid/",
		});
	const input = {
		id: "deps-bun",
		repository: "fixture/repo",
		baseSha: git(f.source, "rev-parse", "HEAD"),
		defaultBranch: "main",
	};
	const plan = {
		manifest: "package.json",
		section: "dependencies" as const,
		name: "demo",
		version: "2.0.0",
	};
	const missing = driverFor("missing", { files: ["package.json"] });
	await expect(missing.updateDependency(await missing.prepare(input), plan)).rejects.toThrow(
		/Lockfile/,
	);
	const unchecked = driverFor("unchecked", { checks: ["absent"] });
	const unknown = await unchecked.prepare(input);
	await expect(
		unchecked.check(unknown, {
			contentFingerprint: (await unchecked.snapshot(unknown)).contentFingerprint,
		}),
	).rejects.toThrow(/missing from baseline/);
	const driver = driverFor("bun", {
		manager: "bun",
		files: ["package.json", "bun.lock", "src/fix.ts"],
	});
	const ws = await driver.prepare(input);
	run.mockImplementationOnce(async (request) => {
		expect(request.command).toBe("bun");
		expect(request.args).toEqual(["install"]);
		expect(request.env?.BUN_CONFIG_REGISTRY).toBe("https://mirror.example.invalid/");
		await writeFile(join(request.cwd, "bun.lock"), '{"v":2}\n');
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	const changed = await driver.updateDependency(ws, plan);
	const checks = await driver.check(ws, { contentFingerprint: changed.contentFingerprint });
	git(ws.path, "config", "core.hooksPath", ".wrong");
	await expect(
		driver.commit(ws, {
			contentFingerprint: changed.contentFingerprint,
			files: changed.changedPaths,
			message: "fix",
			checks,
		}),
	).rejects.toThrow(/hooks/);
});
it("bounds and redacts diagnostics and hides thrown adapter and commit errors", async () => {
	const secret = `giraffe_${"x".repeat(10000)}`;
	const diagnostic = new WorkspaceError(
		"check failed",
		`TS1005: expected semicolon\n${secret}\n${"line\n".repeat(150)}`,
	);
	expect(diagnostic.details).toContain("oversized diagnostic line omitted");
	expect(diagnostic.details).not.toContain("giraffe_");
	const privateOutput =
		"TS2322:\tmissing import\r\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nCookie: session=cookie-secret\nAuthorization: Bearer bearer-secret\n";
	const redacted = new WorkspaceError("check failed", `${privateOutput}${"\u754c".repeat(1000)}`);
	expect(Buffer.byteLength(redacted.details ?? "")).toBeLessThanOrEqual(2048);
	expect(redacted.details).not.toMatch(/private-material|cookie-secret|bearer-secret|\uFFFD/);
	const f = await prepared();
	f.run.mockRejectedValueOnce(new Error("adapter-secret"));
	const thrown = await f.driver
		.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint })
		.catch((error) => error);
	expect(thrown.details).toBeUndefined();
	expect(thrown.message).not.toContain("adapter-secret");
	f.run.mockResolvedValueOnce({ exitCode: 0, stdout: "x".repeat(1100000), stderr: "" });
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: f.snapshot.contentFingerprint }),
	).rejects.toThrow(/bounds/);
	f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "commit-secret", stderr: "host-secret" });
	const error = await f.driver.commit(f.workspace, f.commit).catch((value) => value);
	expect(error.details).toBeUndefined();
	expect(error.message).not.toContain("secret");
});
it("requires clean exact-code publication and rejects failed, unconfirmed and mutating transports", async () => {
	let mode = "empty";
	const transport: HostGitTransport = async (request) => {
		expect(request.signal).toBeDefined();
		if (mode === "throw") throw new Error("private transport error");
		if (mode === "fail") return { exitCode: 1, stdout: "private", stderr: "secret" };
		if (mode === "mutate" && request.operation === "push")
			await writeFile(join(request.cwd, "src/fix.ts"), "changed during prepush");
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	const run = runner();
	const f = await fixture({ run, transport });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed");
	const before = await f.driver.snapshot(f.workspace);
	const checked = await f.driver.check(f.workspace, {
		contentFingerprint: before.contentFingerprint,
	});
	const signal = new AbortController().signal;
	await expect(
		f.driver.push(f.workspace, { ...proofFor(before, checked), signal }),
	).rejects.toThrow(/clean/);
	const committed = await f.driver.commit(f.workspace, {
		contentFingerprint: before.contentFingerprint,
		files: before.changedPaths,
		message: "fix",
		checks: checked,
	});
	const proof = { ...proofFor(committed, checked), signal };
	await expect(
		f.driver.push(f.workspace, {
			...proof,
			signoff: { ...proof.signoff, validationDigest: "stale" },
		}),
	).rejects.toThrow(/signoff/);
	await expect(f.driver.push(f.workspace, proof)).rejects.toThrow(/not confirmed/);
	for (const value of ["throw", "fail"]) {
		mode = value;
		const failed = await f.driver.push(f.workspace, proof).catch((error) => error);
		expect(failed.message).toMatch(/transport/);
		expect(failed.details).toBeUndefined();
		expect(failed.message).not.toMatch(/private|secret/);
	}
	mode = "mutate";
	await expect(f.driver.push(f.workspace, proof)).rejects.toThrow(/changed signed content/);
});
it("clones through the native transport without trusting a different remote or modifying provenance", async () => {
	const f = await fixture({ run: runner() });
	const transport: HostGitTransport = async (request) => {
		const args = request.command.args.map((arg) =>
			arg === "https://github.com/fixture/repo.git" || arg === "origin" ? f.source : arg,
		);
		return { exitCode: 0, stdout: git(request.cwd, ...args), stderr: "" };
	};
	const profile = { ...f.profile, files: [...f.profile.files, "README.md"] };
	const driver = new WorkspaceDriver({
		root: join(f.root, "host"),
		profiles: { "fixture/repo": profile },
		gitTransport: transport,
		run: runner(),
	});
	const ws = await driver.prepare({
		id: "deps-host",
		repository: "fixture/repo",
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	await expect(driver.writeFile(ws, "README.md", "changed")).rejects.toThrow(/Protected/);
	await driver.writeFile(ws, "src/fix.ts", "fixed");
	const before = await driver.snapshot(ws);
	const checks = await driver.check(ws, { contentFingerprint: before.contentFingerprint });
	const snapshot = await driver.commit(ws, {
		contentFingerprint: before.contentFingerprint,
		files: before.changedPaths,
		message: "fix",
		checks,
	});
	await expect(driver.push(ws, proofFor(snapshot, checks))).rejects.toThrow(/remote changed/);
	git(ws.path, "remote", "set-url", "origin", "https://github.com/fixture/repo.git");
	expect((await driver.push(ws, proofFor(snapshot, checks))).reconciled).toBe(false);
	expect((await driver.push(ws, proofFor(snapshot, checks))).reconciled).toBe(true);
});
it("rejects an inactive baseline hook and binary or excessive review diffs", async () => {
	const f = await fixture({ run: runner() });
	await writeFile(join(f.source, ".hooks/pre-commit"), "");
	await writeFile(join(f.source, "binary.txt"), Buffer.from([0, 1, 2]));
	git(f.source, "add", ".hooks/pre-commit", "binary.txt");
	git(f.source, "commit", "-m", "inactive fixture hook");
	const driver = new WorkspaceDriver({
		root: join(f.root, "edge"),
		profiles: {
			"fixture/repo": {
				...f.profile,
				files: [...f.profile.files, "binary.txt", ".hooks/pre-commit"],
			},
		},
		localSources: { "fixture/repo": f.source },
		run: runner(),
	});
	const ws = await driver.prepare({
		id: "deps-edge",
		repository: "fixture/repo",
		baseSha: git(f.source, "rev-parse", "HEAD"),
		defaultBranch: "main",
	});
	const snapshot = await driver.snapshot(ws);
	await expect(
		driver.check(ws, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow(/hook unavailable/);
	await writeFile(join(ws.path, ".hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
	await expect(
		driver.check(ws, { contentFingerprint: (await driver.snapshot(ws)).contentFingerprint }),
	).rejects.toThrow(/hook changed/);
	await writeFile(join(ws.path, ".hooks/pre-commit"), "");
	await driver.writeFile(ws, "binary.txt", "text replacement\n");
	await expect(driver.snapshot(ws)).rejects.toThrow(/Binary diff/);
	for (let index = 0; index < 101; index++) await writeFile(join(ws.path, `extra-${index}`), "x");
	await expect(driver.snapshot(ws)).rejects.toThrow(/Too many/);
});
it("does not race rollback against a process whose cleanup failed", async () => {
	const run = runner();
	const f = await fixture({ run });
	const before = await f.driver.snapshot(f.workspace);
	run.mockRejectedValueOnce(new LocalCleanupError());
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: before.contentFingerprint }),
	).rejects.toBeInstanceOf(LocalCleanupError);
	run.mockImplementationOnce(async (request) => {
		await writeFile(join(request.cwd, "package-lock.json"), "partial");
		throw new LocalCleanupError();
	});
	await expect(
		f.driver.updateDependency(f.workspace, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toBeInstanceOf(LocalCleanupError);
	expect(await f.driver.readFile(f.workspace, "package.json")).toContain("2.0.0");
	expect(await f.driver.readFile(f.workspace, "package-lock.json")).toBe("partial");
	const g = await prepared();
	g.run.mockRejectedValueOnce(new LocalCleanupError());
	await expect(g.driver.commit(g.workspace, g.commit)).rejects.toBeInstanceOf(LocalCleanupError);
	expect(git(g.workspace.path, "diff", "--cached", "--name-only")).toBe("src/fix.ts");
	expect(await readFile(join(g.driver.root, `${g.workspace.id}.commit.json`), "utf8")).toContain(
		g.snapshot.contentFingerprint,
	);
});
it("retains a host transport cleanup failure for operator intervention", async () => {
	const f = await fixture({
		run: runner(),
		transport: async () => {
			throw new LocalCleanupError();
		},
	});
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed");
	const snap = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, { contentFingerprint: snap.contentFingerprint });
	const committed = await f.driver.commit(f.workspace, {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks,
	});
	await expect(f.driver.push(f.workspace, proofFor(committed, checks))).rejects.toBeInstanceOf(
		LocalCleanupError,
	);
});
