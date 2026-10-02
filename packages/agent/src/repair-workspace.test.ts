import { execFileSync } from "node:child_process";
import {
	chmod,
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
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type HostGitTransport, type SandboxRunner, WorkspaceDriver } from "./repair-workspace.ts";

vi.setConfig({ testTimeout: 20000 });

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	}).trim();
async function fixture(
	adapters: { sandbox?: SandboxRunner; gitTransport?: HostGitTransport } = {},
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "repair-workspace-")));
	roots.push(root);
	const source = join(root, "source");
	await mkdir(source);
	git(source, "init", "-b", "main");
	await writeFile(
		join(source, "package.json"),
		JSON.stringify({
			name: "fixture",
			scripts: { test: "node test.cjs" },
			dependencies: { demo: "1.0.0" },
		}),
	);
	await writeFile(join(source, "package-lock.json"), "{}\n");
	await writeFile(join(source, "AGENTS.md"), "Checks: npm run test\n");
	await mkdir(join(source, ".hooks"));
	await writeFile(join(source, ".hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	await writeFile(join(source, ".hooks/pre-push"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", {
		mode: 0o755,
	});
	git(
		source,
		"add",
		"package.json",
		"package-lock.json",
		"AGENTS.md",
		".hooks/pre-commit",
		".hooks/pre-push",
	);
	git(source, "commit", "-m", "fixture");
	const baseSha = git(source, "rev-parse", "HEAD");
	const driver = new WorkspaceDriver({
		root: join(root, "workspaces"),
		...adapters,
		localSources: { "fixture/repo": source },
		profiles: {
			"fixture/repo": {
				manager: "npm",
				files: ["package.json", "package-lock.json", "src/fix.ts"],
				checks: ["test"],
				hooksPath: ".hooks",
			},
		},
	});
	const workspace = await driver.prepare({
		id: "deps-issue-1",
		repository: "fixture/repo",
		baseSha,
		defaultBranch: "main",
	});
	return { driver, workspace, source, root, baseSha };
}
it("isolates a stable repair branch and snapshots exact bounded file contents", async () => {
	const { driver, workspace, source, baseSha } = await fixture();
	expect(workspace.branch).toBe("giraffe/deps-issue-1");
	expect(git(source, "rev-parse", "HEAD")).toBe(baseSha);
	const before = await driver.snapshot(workspace);
	expect(before.changedPaths).toEqual([]);
	await driver.writeFile(
		workspace,
		"package.json",
		'{"name":"fixture","scripts":{"test":"node test.cjs"},"dependencies":{"demo":"2.0.0"}}',
	);
	const after = await driver.snapshot(workspace);
	expect(after.changedPaths).toEqual(["package.json"]);
	expect(after.contentFingerprint).not.toBe(before.contentFingerprint);
	expect(after.manifestBeforeAfter["package.json"]?.after).toContain("2.0.0");
	expect(await readFile(join(source, "package.json"), "utf8")).toContain("1.0.0");
	await expect(
		driver.check(workspace, { contentFingerprint: after.contentFingerprint, commands: ["test"] }),
	).rejects.toThrow(/sandbox/i);
});
it("rejects path escapes, credentials, symlinks and dirty index", async () => {
	const { driver, workspace, root } = await fixture();
	for (const path of [
		"../outside",
		"/tmp/outside",
		".git/config",
		".env",
		"nested/.env.local",
		".npmrc",
		"unknown.txt",
	]) {
		await expect(driver.readFile(workspace, path)).rejects.toThrow();
		await expect(driver.writeFile(workspace, path, "bad")).rejects.toThrow();
	}
	await symlink(root, join(workspace.path, "src"));
	await expect(driver.writeFile(workspace, "src/fix.ts", "bad")).rejects.toThrow(/symlink/i);
	await rm(join(workspace.path, "src"));
	await driver.writeFile(
		workspace,
		"package.json",
		'{"name":"changed","scripts":{"test":"node test.cjs"}}',
	);
	git(workspace.path, "add", "package.json");
	await expect(driver.snapshot(workspace)).rejects.toThrow(/index/i);
});
it("rejects default/invalid refs, stale signoff and unavailable publication transport", async () => {
	const { driver, workspace } = await fixture();
	const snap = await driver.snapshot(workspace);
	await expect(
		driver.push(workspace, {
			head: snap.head,
			contentFingerprint: snap.contentFingerprint,
			signoff: {
				head: "0".repeat(40),
				contentFingerprint: snap.contentFingerprint,
				validationDigest: "fake",
			},
			checks: {
				contentFingerprint: snap.contentFingerprint,
				validationDigest: "fake",
				commands: ["test"],
				results: [],
			},
		}),
	).rejects.toThrow();
	await expect(
		driver.prepare({
			id: "../main",
			repository: "fixture/repo",
			baseSha: snap.head,
			defaultBranch: "main",
		}),
	).rejects.toThrow();
	await expect(driver.snapshot({ ...workspace, branch: "main" })).rejects.toThrow();
	await expect(
		driver.prepare({
			id: "new",
			repository: "https://evil/repo",
			baseSha: snap.head,
			defaultBranch: "main",
		}),
	).rejects.toThrow();
});

function fixtureRunner(): SandboxRunner {
	return {
		verified: true,
		capabilities: { filesystem: true, network: true, resourceLimits: true },
		limitations: ["Synthetic temp fixture only; no production isolation claimed"],
		run: vi.fn(async (request) => {
			if (request.purpose === "commit") git(request.workspace.path, ...request.argv.slice(1));
			else if (request.purpose === "prepush")
				execFileSync(request.argv[0] as string, request.argv.slice(1), {
					cwd: request.workspace.path,
					input: request.stdin,
					env: { PATH: process.env.PATH, HOME: request.workspace.path },
					timeout: 5000,
				});
			else if (request.purpose === "install")
				await writeFile(join(request.workspace.path, "package-lock.json"), '{"updated":true}\n');
			return { exitCode: 0, stdout: "fixture check passed", stderr: "" };
		}),
	};
}
it("checks and commits unchanged content, runs prepush isolated, publishes exact SHA to a bare fixture and reconciles retries", async () => {
	const runner = fixtureRunner();
	let remote = "";
	const transport: HostGitTransport = async (request) => {
		expect(request.command.args).not.toContain("--force");
		expect(request.command.args).not.toContain("--no-verify");
		if (request.operation === "remoteHead")
			return {
				exitCode: 0,
				stdout: remote ? `${remote}\trefs/heads/giraffe/deps-issue-1` : "",
				stderr: "",
			};
		expect(request.operation).toBe("push");
		expect(git(request.cwd, "rev-parse", "--is-bare-repository")).toBe("true");
		expect(await readFile(join(request.cwd, "config"), "utf8")).not.toContain("hooksPath");
		const ref = request.command.args.at(-1) as string;
		remote = ref.split(":")[0] as string;
		return { exitCode: 0, stdout: "pushed fixture", stderr: "" };
	};
	const { driver, workspace } = await fixture({ sandbox: runner, gitTransport: transport });
	const updated = await driver.updateDependency(workspace, {
		manifest: "package.json",
		section: "dependencies",
		name: "demo",
		version: "2.0.0",
	});
	expect(updated.changedPaths).toEqual(["package-lock.json", "package.json"]);
	const checks = await driver.check(workspace, { contentFingerprint: updated.contentFingerprint });
	expect(checks.results[0]?.exitCode).toBe(0);
	const committed = await driver.commit(workspace, {
		contentFingerprint: updated.contentFingerprint,
		files: updated.changedPaths,
		message: "fix: update fixture dependency",
		checks,
	});
	expect(committed.head).not.toBe(workspace.baseSha);
	expect(committed.contentFingerprint).toBe(updated.contentFingerprint);
	const input = {
		head: committed.head,
		contentFingerprint: committed.contentFingerprint,
		checks,
		signoff: {
			head: committed.head,
			contentFingerprint: committed.contentFingerprint,
			validationDigest: checks.validationDigest,
		},
	};
	expect(await driver.push(workspace, input)).toMatchObject({ reconciled: false });
	expect(await driver.push(workspace, input)).toMatchObject({ reconciled: true });
	expect(
		vi.mocked(runner.run).mock.calls.find(([r]) => r.purpose === "prepush")?.[0].stdin,
	).toContain(committed.head);
	remote = "a".repeat(40);
	await expect(driver.push(workspace, input)).rejects.toThrow(/differs/);
});
it("includes untracked file content, refuses scripts weakening, forged check proof and postcheck mutation", async () => {
	const runner = fixtureRunner();
	const { driver, workspace } = await fixture({ sandbox: runner });
	await expect(
		driver.writeFile(workspace, "package.json", '{"scripts":{"test":"true"}}'),
	).rejects.toThrow(/scripts/);
	await driver.writeFile(workspace, "src/fix.ts", "export const fixed = true;\n");
	const snap = await driver.snapshot(workspace);
	expect(snap.diff).toContain("fixed");
	await expect(driver.check(workspace, { contentFingerprint: "old" })).rejects.toThrow(/Stale/);
	await expect(
		driver.check(workspace, { contentFingerprint: snap.contentFingerprint, commands: ["evil"] }),
	).rejects.toThrow(/configured/);
	const checks = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	checks.validationDigest = "forged";
	await expect(
		driver.commit(workspace, {
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
			message: "fix",
			checks,
		}),
	).rejects.toThrow(/Checks/);
	const fresh = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	await driver.writeFile(workspace, "src/fix.ts", "export const fixed = false;\n");
	await expect(
		driver.commit(workspace, {
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
			message: "fix",
			checks: fresh,
		}),
	).rejects.toThrow(/Stale/);
});
it("fails closed on hook and sandbox errors and restores manifest/lock after installer failure", async () => {
	const runner = fixtureRunner();
	const { driver, workspace } = await fixture({ sandbox: runner });
	const original = await driver.readFile(workspace, "package.json");
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout: "",
		stderr: "private detail",
	});
	await expect(
		driver.updateDependency(workspace, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toThrow("Sandbox operation failed");
	expect(await driver.readFile(workspace, "package.json")).toBe(original);
	await writeFile(join(workspace.path, ".hooks/pre-commit"), "");
	const snap = await driver.snapshot(workspace).catch(() => null);
	expect(snap).toBeNull();
});

it("reopens only the same workspace identity and rejects mismatched bases and profiles", async () => {
	const { driver, workspace, baseSha, source, root } = await fixture();
	expect(
		await driver.prepare({
			id: workspace.id,
			repository: workspace.repository,
			baseSha,
			defaultBranch: "main",
		}),
	).toEqual(workspace);
	await expect(
		driver.prepare({
			id: workspace.id,
			repository: workspace.repository,
			baseSha: "a".repeat(40),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/identity/);
	await expect(
		driver.prepare({
			id: "deps-new",
			repository: workspace.repository,
			baseSha: "a".repeat(40),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/Git|SHA/);
	const noProfile = new WorkspaceDriver({
		root: join(root, "empty"),
		profiles: {},
		localSources: { "fixture/repo": source },
	});
	await expect(
		noProfile.prepare({
			id: "deps-new",
			repository: "fixture/repo",
			baseSha,
			defaultBranch: "main",
		}),
	).rejects.toThrow(/profile/);
	for (const patch of [{ checks: ["bad script"] }, { files: [".env"] }, { hooksPath: "" }]) {
		const p = new WorkspaceDriver({
			root: join(root, `invalid-${Math.random()}`),
			profiles: {
				"fixture/repo": {
					manager: "npm",
					checks: ["test"],
					files: ["package.json"],
					hooksPath: ".hooks",
					...patch,
				},
			},
		});
		await expect(
			p.prepare({ id: "deps-invalid", repository: "fixture/repo", baseSha, defaultBranch: "main" }),
		).rejects.toThrow();
	}
});
it("rejects symlink roots, tracked symlinks, unsafe attributes and binary or oversized writes", async () => {
	const { driver, workspace, source, root, baseSha } = await fixture();
	await symlink(join(root, "workspaces"), join(root, "alias"));
	const alias = new WorkspaceDriver({
		root: join(root, "alias"),
		profiles: {
			"fixture/repo": {
				manager: "npm",
				checks: ["test"],
				files: ["package.json"],
				hooksPath: ".hooks",
			},
		},
	});
	await expect(
		alias.prepare({ id: "deps-x", repository: "fixture/repo", baseSha, defaultBranch: "main" }),
	).rejects.toThrow(/symlink/);
	await expect(driver.writeFile(workspace, "src/fix.ts", "\0")).rejects.toThrow(/binary/);
	await expect(driver.writeFile(workspace, "src/fix.ts", "x".repeat(270000))).rejects.toThrow(
		/limit/,
	);
	await writeFile(join(workspace.path, "src.txt"), "not allowed");
	await expect(driver.snapshot(workspace)).rejects.toThrow(/allowlist/);
	await rm(join(workspace.path, "src.txt"));
	await writeFile(join(source, ".gitattributes"), "*.txt filter=evil");
	git(source, "add", ".gitattributes");
	git(source, "commit", "-m", "attributes");
	await expect(
		driver.prepare({
			id: "deps-attrs",
			repository: "fixture/repo",
			baseSha: git(source, "rev-parse", "HEAD"),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/filters/);
	await rm(join(source, ".gitattributes"));
	git(source, "add", ".gitattributes");
	await symlink("/tmp", join(source, "link"));
	git(source, "add", "link");
	git(source, "commit", "-m", "symlink");
	await expect(
		driver.prepare({
			id: "deps-link",
			repository: "fixture/repo",
			baseSha: git(source, "rev-parse", "HEAD"),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/Symlinks/);
});
it("requires complete review and captures deleted/new files without silent truncation", async () => {
	const { driver, workspace } = await fixture();
	await driver.writeFile(workspace, "src/fix.ts", "x".repeat(45000));
	await expect(driver.snapshot(workspace)).rejects.toThrow(/40 KiB/);
	await rm(join(workspace.path, "src"), { recursive: true });
	await rm(join(workspace.path, "package.json"));
	const snapshot = await driver.snapshot(workspace);
	expect(snapshot.manifestBeforeAfter["package.json"]?.after).toBeNull();
	await writeFile(join(workspace.path, "package.json"), Buffer.from([0, 1, 2]));
	await expect(driver.snapshot(workspace)).rejects.toThrow(/binary/);
});
it("rejects stale/invalid package updates and sandbox capability or output errors", async () => {
	const runner = fixtureRunner();
	const { driver, workspace } = await fixture({ sandbox: runner });
	for (const input of [
		{ manifest: "nested/package.json", section: "dependencies", name: "demo", version: "2.0.0" },
		{ manifest: "package.json", section: "dependencies", name: "demo", version: "https://evil" },
		{ manifest: "package.json", section: "dependencies", name: "missing", version: "2.0.0" },
	] as const)
		await expect(driver.updateDependency(workspace, input)).rejects.toThrow();
	const baseline = await driver.snapshot(workspace);
	runner.capabilities.network = false;
	await expect(
		driver.check(workspace, { contentFingerprint: baseline.contentFingerprint }),
	).rejects.toThrow(/sandbox/);
	runner.capabilities.network = true;
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 0,
		stdout: "x".repeat(1100000),
		stderr: "",
	});
	await expect(
		driver.check(workspace, { contentFingerprint: baseline.contentFingerprint }),
	).rejects.toThrow(/bounds/);
	vi.mocked(runner.run).mockImplementationOnce(async () => {
		await driver.writeFile(workspace, "src/fix.ts", "changed");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		driver.check(workspace, { contentFingerprint: baseline.contentFingerprint }),
	).rejects.toThrow(/changed/);
	await expect(
		driver.updateDependency(workspace, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toThrow(/replay/);
});
it("blocks missing executable hooks and preserves deterministic check proofs across fresh checks", async () => {
	const runner = fixtureRunner();
	const { driver, workspace } = await fixture({ sandbox: runner });
	const snap = await driver.snapshot(workspace);
	const a = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 0,
		stdout: "different timestamp",
		stderr: "",
	});
	const b = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	expect(a.validationDigest).toBe(b.validationDigest);
	await expect(
		driver.commit(workspace, {
			contentFingerprint: snap.contentFingerprint,
			files: [],
			message: "empty",
			checks: b,
		}),
	).rejects.toThrow(/explicitly/);
	await chmod(join(workspace.path, ".hooks/pre-commit"), 0o644);
	await expect(
		driver.check(workspace, { contentFingerprint: snap.contentFingerprint }),
	).rejects.toThrow();
});

it("replays dependency installation and an already successful commit without duplicating the commit", async () => {
	const runner = fixtureRunner();
	const { driver, workspace } = await fixture({ sandbox: runner });
	const input = {
		manifest: "package.json",
		section: "dependencies" as const,
		name: "demo",
		version: "2.0.0",
	};
	await driver.updateDependency(workspace, input);
	const snap = await driver.updateDependency(workspace, input);
	const checks = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	const command = {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks,
	};
	const committed = await driver.commit(workspace, command);
	expect(await driver.commit(workspace, command)).toEqual(committed);
	expect(vi.mocked(runner.run).mock.calls.filter(([r]) => r.purpose === "commit")).toHaveLength(1);
});

it("blocks exact-code push mismatches, dirty work, prepush changes and remote races", {
	timeout: 20000,
}, async () => {
	const runner = fixtureRunner();
	let state = "empty",
		reads = 0;
	const transport: HostGitTransport = async (req) => {
		if (req.operation === "remoteHead") {
			reads++;
			return {
				exitCode: 0,
				stdout: state === "race" && reads > 1 ? "a".repeat(40) : "",
				stderr: "",
			};
		}
		return { exitCode: state === "fail" ? 1 : 0, stdout: "", stderr: "" };
	};
	const { driver, workspace } = await fixture({ sandbox: runner, gitTransport: transport });
	await driver.writeFile(workspace, "src/fix.ts", "fixed");
	const snap = await driver.snapshot(workspace);
	let checks = await driver.check(workspace, { contentFingerprint: snap.contentFingerprint });
	let committed = await driver.commit(workspace, {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks,
	});
	const proof = () => ({
		head: committed.head,
		contentFingerprint: committed.contentFingerprint,
		checks,
		signoff: {
			head: committed.head,
			contentFingerprint: committed.contentFingerprint,
			validationDigest: checks.validationDigest,
		},
	});
	await expect(driver.push(workspace, { ...proof(), head: "a".repeat(40) })).rejects.toThrow(
		/signoff/,
	);
	await expect(
		driver.push(workspace, {
			...proof(),
			signoff: { ...proof().signoff, validationDigest: "bad" },
		}),
	).rejects.toThrow(/signoff/);
	await driver.writeFile(workspace, "src/fix.ts", "new");
	const dirty = await driver.snapshot(workspace);
	checks = await driver.check(workspace, { contentFingerprint: dirty.contentFingerprint });
	await expect(
		driver.push(workspace, {
			head: dirty.head,
			contentFingerprint: dirty.contentFingerprint,
			checks,
			signoff: {
				head: dirty.head,
				contentFingerprint: dirty.contentFingerprint,
				validationDigest: checks.validationDigest,
			},
		}),
	).rejects.toThrow(/clean/);
	await driver.writeFile(workspace, "src/fix.ts", "fixed");
	checks = await driver.check(workspace, { contentFingerprint: committed.contentFingerprint });
	state = "race";
	reads = 0;
	await expect(driver.push(workspace, proof())).rejects.toThrow(/changed during hooks/);
	state = "empty";
	reads = 0;
	await expect(driver.push(workspace, proof())).rejects.toThrow(/not confirmed/);
	state = "fail";
	await expect(driver.push(workspace, proof())).rejects.toThrow(/transport failed/);
	vi.mocked(runner.run).mockImplementationOnce(async () => {
		await driver.writeFile(workspace, "src/fix.ts", "mutated");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(driver.push(workspace, proof())).rejects.toThrow(/changed signed/);
	committed = await driver.snapshot(workspace);
	expect(committed.contentFingerprint).not.toBe(snap.contentFingerprint);
});
it("validates tracked secrets, hook activation, managers and installer side effects", async () => {
	const { root, source, baseSha } = await fixture();
	const profile = {
		manager: "bun" as const,
		checks: ["test"],
		files: ["package.json", "bun.lock", "src/fix.ts"],
		hooksPath: ".hooks",
	};
	await writeFile(join(source, "bun.lock"), "{}");
	git(source, "add", "bun.lock");
	git(source, "commit", "-m", "bun lock");
	const base = git(source, "rev-parse", "HEAD");
	const runner = fixtureRunner();
	vi.mocked(runner.run).mockImplementation(async (req) => {
		if (req.purpose === "install") {
			expect(req.argv).toEqual(["bun", "install", "--ignore-scripts"]);
			await writeFile(join(req.workspace.path, "bun.lock"), '{"v":2}');
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	const driver = new WorkspaceDriver({
		root: join(root, "bun-workspaces"),
		profiles: { "fixture/repo": profile },
		localSources: { "fixture/repo": source },
		sandbox: runner,
	});
	const ws = await driver.prepare({
		id: "deps-bun",
		repository: "fixture/repo",
		baseSha: base,
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
	git(ws.path, "config", "core.hooksPath", ".wrong");
	await expect(
		driver.commit(ws, {
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
			message: "fix",
			checks,
		}),
	).rejects.toThrow(/seal changed/);
	await writeFile(join(source, ".env"), "FAKE=fixture");
	git(source, "add", ".env");
	git(source, "commit", "-m", "credential path");
	await expect(
		driver.prepare({
			id: "deps-secret",
			repository: "fixture/repo",
			baseSha: git(source, "rev-parse", "HEAD"),
			defaultBranch: "main",
		}),
	).rejects.toThrow(/Credential/);
	await expect(
		driver.prepare({
			id: "deps-bad",
			repository: "fixture/repo",
			baseSha,
			defaultBranch: "giraffe/deps-bad",
		}),
	).rejects.toThrow(/Default branch/);
});
it("prevents branch mutation, unsafe file types, hardlinks and ignored review files", async () => {
	const { driver, workspace, root } = await fixture();
	git(workspace.path, "checkout", "-b", "other");
	await expect(driver.snapshot(workspace)).rejects.toThrow(/branch changed/);
	git(workspace.path, "checkout", workspace.branch);
	await mkdir(join(workspace.path, "src/fix.ts"), { recursive: true });
	await expect(driver.writeFile(workspace, "src/fix.ts", "x")).rejects.toThrow(/Unsafe file/);
	await expect(driver.readFile(workspace, "src/fix.ts")).rejects.toThrow(/regular/);
	await rm(join(workspace.path, "src"), { recursive: true });
	await writeFile(join(root, "hard"), "x");
	await mkdir(join(workspace.path, "src"));
	await link(join(root, "hard"), join(workspace.path, "src/fix.ts"));
	await expect(driver.writeFile(workspace, "src/fix.ts", "x")).rejects.toThrow(/Unsafe file/);
	await rm(join(workspace.path, "src/fix.ts"));
	await mkdir(join(workspace.path, ".git/info"), { recursive: true });
	await writeFile(join(workspace.path, ".git/info/exclude"), "src/fix.ts\n");
	await writeFile(join(workspace.path, "src/fix.ts"), "ignored");
	await expect(driver.snapshot(workspace)).rejects.toThrow(/seal changed/);
});

it("uses only explicit host clone transport, blocks missing transport and verifies prepare identity", async () => {
	const f = await fixture();
	const profiles = {
		"fixture/repo": {
			manager: "npm" as const,
			checks: ["test"],
			files: ["package.json", "package-lock.json", "src/fix.ts", "README.md"],
			hooksPath: ".hooks",
		},
	};
	const host: HostGitTransport = async (req) => {
		expect(req.operation).toBe("clone");
		const args = [...req.command.args];
		args[args.length - 2] = f.source;
		git(req.cwd, ...args);
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	const driver = new WorkspaceDriver({ root: join(f.root, "host"), profiles, gitTransport: host });
	const ws = await driver.prepare({
		id: "deps-host",
		repository: "fixture/repo",
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	await expect(driver.writeFile(ws, "README.md", "change")).rejects.toThrow(/Protected/);
	const missing = new WorkspaceDriver({ root: join(f.root, "no-transport"), profiles });
	await expect(
		missing.prepare({
			id: "deps-missing",
			repository: "fixture/repo",
			baseSha: f.baseSha,
			defaultBranch: "main",
		}),
	).rejects.toThrow(/transport required/);
	await rename(ws.path, `${ws.path}-old`);
	await symlink(`${ws.path}-old`, ws.path);
	await expect(driver.snapshot(ws)).rejects.toThrow(/symlink/);
});
it("checks immutable baseline scripts and actual active executable hooks before trusting receipts", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snapshot = await f.driver.snapshot(f.workspace);
	await writeFile(join(f.workspace.path, "package.json"), '{"scripts":{"test":"true"}}');
	const changed = await f.driver.snapshot(f.workspace);
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: changed.contentFingerprint }),
	).rejects.toThrow(/scripts/);
	await writeFile(
		join(f.workspace.path, "package.json"),
		await readFile(join(f.source, "package.json")),
	);
	await chmod(join(f.workspace.path, ".hooks/pre-commit"), 0o644);
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow();
	await chmod(join(f.workspace.path, ".hooks/pre-commit"), 0o755);
	await writeFile(join(f.workspace.path, ".hooks/pre-commit"), "#!/bin/sh\nexit 1\n");
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow();
});

it("refuses unavailable profiles scripts, unexpected installer edits and post-commit content mutations", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	vi.mocked(runner.run).mockImplementationOnce(async () => {
		await f.driver.writeFile(f.workspace, "src/fix.ts", "unexpected");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		f.driver.updateDependency(f.workspace, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toThrow(/unexpected/);
	await rm(join(f.workspace.path, "src"), { recursive: true });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "expected");
	const snapshot = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
	});
	vi.mocked(runner.run).mockImplementationOnce(async (req) => {
		git(req.workspace.path, ...req.argv.slice(1));
		await f.driver.writeFile(f.workspace, "src/fix.ts", "hook changed");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		f.driver.commit(f.workspace, {
			contentFingerprint: snapshot.contentFingerprint,
			files: snapshot.changedPaths,
			message: "fix",
			checks,
		}),
	).rejects.toThrow(/intent content mismatch/);
	const p = new WorkspaceDriver({
		root: join(f.root, "badcheck"),
		localSources: { "fixture/repo": f.source },
		profiles: {
			"fixture/repo": {
				manager: "npm",
				checks: ["missing"],
				files: ["package.json"],
				hooksPath: ".hooks",
			},
		},
		sandbox: runner,
	});
	const w = await p.prepare({
		id: "deps-check",
		repository: "fixture/repo",
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	await expect(
		p.check(w, { contentFingerprint: (await p.snapshot(w)).contentFingerprint }),
	).rejects.toThrow(/missing/);
});

it("bounds total changed paths and requires a tracked configured lockfile", async () => {
	expect(new WorkspaceDriver({ profiles: {} }).root).toContain("giraffe/worktrees");
	const f = await fixture();
	const files = Array.from({ length: 101 }, (_, i) => `files/${i}.txt`);
	const driver = new WorkspaceDriver({
		root: join(f.root, "many"),
		localSources: { "fixture/repo": f.source },
		profiles: {
			"fixture/repo": {
				manager: "npm",
				checks: ["test"],
				files: ["package.json", ...files],
				hooksPath: ".hooks",
			},
		},
		sandbox: fixtureRunner(),
	});
	const ws = await driver.prepare({
		id: "deps-many",
		repository: "fixture/repo",
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	await expect(
		driver.updateDependency(ws, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toThrow(/Lockfile/);
	await mkdir(join(ws.path, "files"));
	await Promise.all(files.map((file) => writeFile(join(ws.path, file), "x")));
	await expect(driver.snapshot(ws)).rejects.toThrow(/Too many/);
});

it("restores only its own staged index after failed hooks and resumes commit intents across restart", {
	timeout: 20000,
}, async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "retained");
	const snap = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, { contentFingerprint: snap.contentFingerprint });
	vi.mocked(runner.run).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "hook failed" });
	await expect(
		f.driver.commit(f.workspace, {
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
			message: "fix",
			checks,
		}),
	).rejects.toThrow();
	expect(git(f.workspace.path, "diff", "--cached", "--name-only")).toBe("");
	expect(await f.driver.readFile(f.workspace, "src/fix.ts")).toBe("retained");
	expect((await f.driver.snapshot(f.workspace)).contentFingerprint).toBe(snap.contentFingerprint);
	const intent = join(f.root, "workspaces", `${f.workspace.id}.commit.json`);
	await writeFile(
		intent,
		JSON.stringify({
			beforeHead: snap.head,
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
		}),
	);
	git(f.workspace.path, "add", "src/fix.ts");
	const fresh = new WorkspaceDriver({
		root: join(f.root, "workspaces"),
		profiles: {
			"fixture/repo": {
				manager: "npm",
				checks: ["test"],
				files: ["package.json", "package-lock.json", "src/fix.ts"],
				hooksPath: ".hooks",
			},
		},
		sandbox: runner,
	});
	const ws = await fresh.prepare({
		id: f.workspace.id,
		repository: f.workspace.repository,
		baseSha: f.baseSha,
		defaultBranch: "main",
	});
	expect(git(ws.path, "diff", "--cached", "--name-only")).toBe("");
	const receipt = await fresh.check(ws, { contentFingerprint: snap.contentFingerprint });
	const committed = await fresh.commit(ws, {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks: receipt,
	});
	await writeFile(
		intent,
		JSON.stringify({
			beforeHead: snap.head,
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
		}),
	);
	expect(await fresh.snapshot(ws)).toEqual(committed);
	await writeFile(
		intent,
		JSON.stringify({
			beforeHead: snap.head,
			contentFingerprint: "wrong",
			files: snap.changedPaths,
		}),
	);
	await expect(fresh.snapshot(ws)).rejects.toThrow(/intent/);
});

it("rejects unrelated index/head edits and malformed recovery markers", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "intended");
	const snap = await f.driver.snapshot(f.workspace);
	const marker = join(f.root, "workspaces", `${f.workspace.id}.commit.json`);
	const intent = {
		beforeHead: snap.head,
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
	};
	await writeFile(marker, JSON.stringify({ ...intent, files: [".git/config"] }));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/Invalid commit intent/);
	await writeFile(marker, JSON.stringify(intent));
	git(f.workspace.path, "add", "src/fix.ts");
	await writeFile(join(f.workspace.path, "src/fix.ts"), "changed after staging");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/intent content/);
	await writeFile(join(f.workspace.path, "src/fix.ts"), "intended");
	git(f.workspace.path, "commit", "-m", "first");
	git(f.workspace.path, "commit", "--allow-empty", "-m", "unrelated");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/head mismatch/);
});

it("recovers an intent before staging but rejects an index with bytes different from the marked working tree", async () => {
	const f = await fixture();
	await f.driver.writeFile(f.workspace, "src/fix.ts", "intended");
	const snap = await f.driver.snapshot(f.workspace);
	const marker = join(f.root, "workspaces", `${f.workspace.id}.commit.json`);
	const intent = {
		beforeHead: snap.head,
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
	};
	await writeFile(marker, JSON.stringify(intent));
	expect((await f.driver.snapshot(f.workspace)).contentFingerprint).toBe(snap.contentFingerprint);
	await f.driver.writeFile(f.workspace, "src/fix.ts", "other indexed");
	git(f.workspace.path, "add", "src/fix.ts");
	await f.driver.writeFile(f.workspace, "src/fix.ts", "intended");
	await writeFile(marker, JSON.stringify(intent));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/staged content changed/);
});

it("seals Git metadata against sandbox helper injection before any host Git can execute it", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snapshot = await f.driver.snapshot(f.workspace);
	const marker = join(f.root, "executed");
	vi.mocked(runner.run).mockImplementationOnce(async () => {
		await writeFile(
			join(f.workspace.path, ".git/config"),
			`[core]\n repositoryformatversion = 0\n worktree = ${f.workspace.path}\n[filter "evil"]\n clean = touch ${marker}\n[include]\n path = /tmp/host-config\n`,
		);
		return { exitCode: 0, stdout: "passed", stderr: "" };
	});
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow(/Git|metadata/);
	await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/Git|metadata/);
});
it("rejects metadata symlinks/alternates and checks cancellation before sandbox work", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snap = await f.driver.snapshot(f.workspace);
	const controller = new AbortController();
	controller.abort();
	await expect(
		f.driver.check(f.workspace, {
			contentFingerprint: snap.contentFingerprint,
			signal: controller.signal,
		}),
	).rejects.toThrow(/cancelled/);
	expect(runner.run).not.toHaveBeenCalled();
	await mkdir(join(f.workspace.path, ".git/objects/info"), { recursive: true });
	await writeFile(join(f.workspace.path, ".git/objects/info/alternates"), "/tmp/alternate");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/metadata forbidden/);
	await rm(join(f.workspace.path, ".git/objects/info/alternates"));
	await symlink(f.root, join(f.workspace.path, ".git/escape"));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/metadata path/);
});

it("forwards abort during check/commit and blocks before remote operations", async () => {
	const runner = fixtureRunner();
	const host: HostGitTransport = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
	const f = await fixture({ sandbox: runner, gitTransport: host });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fix");
	const snap = await f.driver.snapshot(f.workspace);
	const controller = new AbortController();
	const normal = vi.mocked(runner.run).getMockImplementation();
	vi.mocked(runner.run).mockImplementationOnce(async (req) => {
		expect(req.signal).toBe(controller.signal);
		controller.abort();
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		f.driver.check(f.workspace, {
			contentFingerprint: snap.contentFingerprint,
			signal: controller.signal,
		}),
	).rejects.toThrow(/cancelled/);
	if (!normal) throw new Error("fixture");
	vi.mocked(runner.run).mockImplementation(normal);
	const checks = await f.driver.check(f.workspace, { contentFingerprint: snap.contentFingerprint });
	await expect(
		f.driver.commit(f.workspace, {
			contentFingerprint: snap.contentFingerprint,
			files: snap.changedPaths,
			message: "fix",
			checks,
			signal: controller.signal,
		}),
	).rejects.toThrow(/cancelled/);
	const committed = await f.driver.commit(f.workspace, {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks,
	});
	await expect(
		f.driver.push(f.workspace, {
			head: committed.head,
			contentFingerprint: committed.contentFingerprint,
			checks,
			signoff: {
				head: committed.head,
				contentFingerprint: committed.contentFingerprint,
				validationDigest: checks.validationDigest,
			},
			signal: controller.signal,
		}),
	).rejects.toThrow(/cancelled/);
	expect(host).not.toHaveBeenCalled();
});
it("detects changed hooks/config, metadata hardlinks and forged metadata directory without running git", async () => {
	const f = await fixture();
	const gitDir = join(f.workspace.path, ".git");
	const config = await readFile(join(gitDir, "config"), "utf8");
	await writeFile(join(gitDir, "config"), `${config}\n[extensions]\nworktreeConfig=true\n`);
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/extensions/);
	await writeFile(join(gitDir, "config"), config);
	await writeFile(join(f.root, "metadata"), "safe");
	await link(join(f.root, "metadata"), join(gitDir, "extra"));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/hardlink/);
	await rm(join(gitDir, "extra"));
	await rename(join(f.workspace.path, ".hooks"), join(f.workspace.path, ".saved-hooks"));
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/seal changed/);
	await rename(join(f.workspace.path, ".saved-hooks"), join(f.workspace.path, ".hooks"));
	await rename(gitDir, `${gitDir}-safe`);
	await writeFile(gitDir, "gitdir: /tmp/evil");
	await expect(f.driver.snapshot(f.workspace)).rejects.toThrow(/metadata directory/);
});
it("allows a configured safe signal to reach prepush and host transport only with clean exact signoff", async () => {
	const runner = fixtureRunner();
	let sha = "";
	const controller = new AbortController();
	const transport: HostGitTransport = async (request) => {
		expect(request.signal).toBe(controller.signal);
		if (request.operation === "push") {
			sha = (request.command.args.at(-1) as string).split(":")[0] as string;
		} else expect(request.cwd).not.toContain("/deps-issue-1");
		return {
			exitCode: 0,
			stdout:
				request.operation === "remoteHead" && sha ? `${sha}\trefs/heads/giraffe/deps-issue-1` : "",
			stderr: "",
		};
	};
	const f = await fixture({ sandbox: runner, gitTransport: transport });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "safe");
	const snap = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, {
		contentFingerprint: snap.contentFingerprint,
		signal: controller.signal,
	});
	const commit = await f.driver.commit(f.workspace, {
		contentFingerprint: snap.contentFingerprint,
		files: snap.changedPaths,
		message: "fix",
		checks,
		signal: controller.signal,
	});
	await f.driver.push(f.workspace, {
		head: commit.head,
		contentFingerprint: commit.contentFingerprint,
		checks,
		signoff: {
			head: commit.head,
			contentFingerprint: commit.contentFingerprint,
			validationDigest: checks.validationDigest,
		},
		signal: controller.signal,
	});
	expect(vi.mocked(runner.run).mock.calls.find(([r]) => r.purpose === "prepush")?.[0].signal).toBe(
		controller.signal,
	);
});

it("checks ignored paths and binary diffs from the trusted initial tree", async () => {
	const f = await fixture();
	await writeFile(join(f.source, ".gitignore"), "src/fix.ts\n");
	await writeFile(join(f.source, "package-lock.json"), Buffer.from([0, 1, 2]));
	git(f.source, "add", ".gitignore", "package-lock.json");
	git(f.source, "commit", "-m", "binary baseline");
	const driver = new WorkspaceDriver({
		root: join(f.root, "binary"),
		localSources: { "fixture/repo": f.source },
		profiles: {
			"fixture/repo": {
				manager: "npm",
				checks: ["test"],
				files: ["package.json", "package-lock.json", "src/fix.ts"],
				hooksPath: ".hooks",
			},
		},
	});
	const ws = await driver.prepare({
		id: "deps-binary",
		repository: "fixture/repo",
		baseSha: git(f.source, "rev-parse", "HEAD"),
		defaultBranch: "main",
	});
	await driver.writeFile(ws, "src/fix.ts", "ignored");
	await expect(driver.snapshot(ws)).rejects.toThrow(/ignored/);
	await rm(join(ws.path, "src/fix.ts"));
	await driver.writeFile(ws, "package-lock.json", "text");
	await expect(driver.snapshot(ws)).rejects.toThrow(/Binary diff/);
});
it("enforces sandbox metadata bounds before accepting a returned check result", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snapshot = await f.driver.snapshot(f.workspace);
	vi.mocked(runner.run).mockImplementationOnce(async () => {
		await writeFile(join(f.workspace.path, ".hooks/pre-commit"), "#!/bin/sh\nexit 0\n#changed\n");
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	await expect(
		f.driver.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint }),
	).rejects.toThrow(/seal changed/);
});

it("blocks a new allowlisted manifest section not evidenced in the immutable baseline on replay", async () => {
	const f = await fixture({ sandbox: fixtureRunner() });
	const text = JSON.parse(await f.driver.readFile(f.workspace, "package.json")) as Record<
		string,
		unknown
	>;
	text.optionalDependencies = { demo: "2.0.0" };
	await f.driver.writeFile(f.workspace, "package.json", JSON.stringify(text));
	await expect(
		f.driver.updateDependency(f.workspace, {
			manifest: "package.json",
			section: "optionalDependencies",
			name: "demo",
			version: "2.0.0",
		}),
	).rejects.toThrow(/baseline/);
});

it("exposes actionable bounded check/install diagnostics with common credentials redacted", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snapshot = await f.driver.snapshot(f.workspace);
	const pat = `ghp_${"a".repeat(36)}`,
		bearer = `giraffe_${"b".repeat(43)}`,
		key = `sk-${"c".repeat(32)}`;
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout: "src/fix.ts(8,3): error TS2322: string is not assignable to number.\n",
		stderr: `Authorization: Bearer ${bearer}\nGITHUB_TOKEN=${pat}\n{"apiKey":"${key}"}\nhttps://user:password@example.invalid/private\n`,
	});
	const error = await f.driver
		.check(f.workspace, { contentFingerprint: snapshot.contentFingerprint })
		.catch((value) => value);
	expect(error.code).toBe("repair_workspace_blocked");
	expect(error.details).toContain("TS2322");
	expect(error.details).toContain("[redacted]");
	for (const secret of [pat, bearer, key, "user:password"])
		expect(error.details).not.toContain(secret);
	expect(error.message).not.toContain("TS2322");
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout: `npm ERR! Could not resolve dependency demo@2.0.0\n${"界".repeat(1000)}`,
		stderr: "",
	});
	const install = await f.driver
		.updateDependency(f.workspace, {
			manifest: "package.json",
			section: "dependencies",
			name: "demo",
			version: "2.0.0",
		})
		.catch((value) => value);
	expect(install.details).toContain("Could not resolve dependency");
	expect(Buffer.byteLength(install.details)).toBeLessThanOrEqual(2048);
	expect(install.details).not.toContain("\uFFFD");
	expect((await f.driver.snapshot(f.workspace)).contentFingerprint).toBe(
		snapshot.contentFingerprint,
	);
});
it("never returns commit/prepush or host transport output as worker diagnostics", async () => {
	const runner = fixtureRunner();
	const transport: HostGitTransport = vi.fn(async () => ({
		exitCode: 1,
		stdout: "host credential",
		stderr: "private host token",
	}));
	const f = await fixture({ sandbox: runner, gitTransport: transport });
	await f.driver.writeFile(f.workspace, "src/fix.ts", "fixed");
	const snapshot = await f.driver.snapshot(f.workspace);
	const checks = await f.driver.check(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
	});
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout: "private commit output",
		stderr: "secret hook output",
	});
	const failed = await f.driver
		.commit(f.workspace, {
			contentFingerprint: snapshot.contentFingerprint,
			files: snapshot.changedPaths,
			message: "fix",
			checks,
		})
		.catch((value) => value);
	expect(failed.details).toBeUndefined();
	expect(failed.message).not.toContain("secret");
	const committed = await f.driver.commit(f.workspace, {
		contentFingerprint: snapshot.contentFingerprint,
		files: snapshot.changedPaths,
		message: "fix",
		checks,
	});
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
	const host = await f.driver.push(f.workspace, proof).catch((value) => value);
	expect(host.details).toBeUndefined();
	expect(host.message).not.toContain("private");
	vi.mocked(transport).mockRejectedValueOnce(new Error("host secret thrown"));
	const thrown = await f.driver.push(f.workspace, proof).catch((value) => value);
	expect(thrown.message).not.toContain("host secret");
	expect(thrown.details).toBeUndefined();
	vi.mocked(transport).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout: "private prepush output",
		stderr: "secret prepush output",
	});
	const hook = await f.driver.push(f.workspace, proof).catch((value) => value);
	expect(hook.details).toBeUndefined();
	expect(hook.message).not.toContain("private");
});
it("sanitizes multiline secrets and adapter failures without introducing credential diagnostics", async () => {
	const runner = fixtureRunner();
	const f = await fixture({ sandbox: runner });
	const snap = await f.driver.snapshot(f.workspace);
	vi.mocked(runner.run).mockResolvedValueOnce({
		exitCode: 1,
		stdout:
			"Error:\tmissing module\r\n-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----\nCookie: session=private-cookie\n",
		stderr: "",
	});
	const error = await f.driver
		.check(f.workspace, { contentFingerprint: snap.contentFingerprint })
		.catch((value) => value);
	expect(error.details).toContain("missing module");
	expect(error.details).not.toContain("fixture-private-material");
	expect(error.details).not.toContain("private-cookie");
	vi.mocked(runner.run).mockRejectedValueOnce(new Error("adapter host secret"));
	const thrown = await f.driver
		.check(f.workspace, { contentFingerprint: snap.contentFingerprint })
		.catch((value) => value);
	expect(thrown.message).not.toContain("adapter host secret");
	expect(thrown.details).toBeUndefined();
});

it("omits oversized diagnostic lines before redaction without leaking truncated credential fragments", async () => {
	const { WorkspaceError } = await import("./repair-workspace.ts");
	const secret = `giraffe_${"x".repeat(10000)}`;
	const error = new WorkspaceError(
		"check failed",
		`error TS1005: expected semicolon\n${secret}\n${"line\n".repeat(150)}`,
	);
	expect(error.details).toContain("expected semicolon");
	expect(error.details).toContain("oversized diagnostic line omitted");
	expect(error.details).not.toContain("giraffe_");
	expect(Buffer.byteLength(error.details ?? "")).toBeLessThanOrEqual(2048);
});
