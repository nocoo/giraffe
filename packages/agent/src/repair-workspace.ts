import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type CheckCommand = { command: string; args: string[] };
export type RepairProfile = {
	manager: "npm" | "bun";
	checks: string[];
	files: string[];
	hooksPath?: string;
};
export type Workspace = {
	path: string;
	branch: string;
	baseSha: string;
	repository: string;
	id: string;
};
export type WorkspaceSnapshot = {
	head: string;
	tree: string;
	baseTree: string;
	contentFingerprint: string;
	diffDigest: string;
	changedPaths: string[];
	diff: string;
	manifestBeforeAfter: Record<string, { before: string | null; after: string | null }>;
	complete: true;
};
export type CheckReceipt = {
	contentFingerprint: string;
	validationDigest: string;
	commands: string[];
	results: { command: string; exitCode: 0; stdout: string; stderr: string }[];
};
export type ReviewSignoff = { head: string; contentFingerprint: string; validationDigest: string };
export type SandboxRequest = {
	workspace: Workspace;
	argv: string[];
	purpose: "install" | "check" | "commit" | "prepush";
	stdin?: string;
	timeoutMs: number;
	signal?: AbortSignal;
};
export type SandboxRunner = {
	verified: true;
	capabilities: { filesystem: boolean; network: boolean; resourceLimits: boolean };
	limitations: string[];
	run(request: SandboxRequest): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};
export type GitTransportRequest = {
	operation: "clone" | "remoteHead" | "push";
	repository: string;
	command: CheckCommand;
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
};
export type HostGitTransport = (
	request: GitTransportRequest,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type WorkspaceDriverOptions = {
	root?: string;
	profiles: Record<string, RepairProfile>;
	sandbox?: SandboxRunner;
	gitTransport?: HostGitTransport;
	localSources?: Record<string, string>;
	gitExecutable?: string;
};

export class WorkspaceError extends Error {
	readonly code = "repair_workspace_blocked";
	readonly details?: string;
	constructor(message: string, diagnostics?: string) {
		super(message);
		this.name = "WorkspaceError";
		if (diagnostics !== undefined) this.details = safeDiagnostics(diagnostics);
	}
}

function safeDiagnostics(output: string): string {
	const bounded = output
		.split("\n")
		.slice(0, 100)
		.map((line) => (line.length > 4096 ? "[oversized diagnostic line omitted]" : line))
		.join("\n");
	const text = bounded
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			"[redacted]",
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|giraffe_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/g,
			"[redacted]",
		)
		.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[redacted]")
		.replace(
			/(^|\n)\s*(?:set-cookie|cookie|authorization|proxy-authorization)\s*:[^\n]*/gi,
			"$1[redacted]",
		)
		.replace(
			/\b((?:[A-Za-z0-9_-]*(?:token|api[_-]?key|secret|password|credential)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
			"$1[redacted]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\p{Cc}/gu, (character) =>
			character === "\n" || character === "\t" ? character : "",
		);
	let result = "",
		bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size > 2048) break;
		result += character;
		bytes += size;
	}
	return result;
}

const MAX_FILE = 256 * 1024,
	MAX_DIFF = 1024 * 1024,
	MAX_FILES = 100;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
	throw new WorkspaceError(message);
}
const validSha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const denied =
	/^(?:\.git|\.dev\.vars(?:\..*)?|\.env(?:\..*)?|\.npmrc|\.yarnrc.*|\.bunfig.*|bunfig\.toml|\.ssh|\.aws|\.config|credentials.*|.*\.(?:pem|key|p12|pfx))$/i;
function fileName(value: string) {
	if (
		!value ||
		isAbsolute(value) ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === ".." || denied.test(part)) ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		fail("Unsafe workspace file");
	return value;
}
async function absent(path: string) {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}
async function plainPath(root: string, path: string, missing = false) {
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(root + sep)) fail("Path escapes workspace");
	let cursor = root;
	for (const part of relative(root, target).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		if (missing && (await absent(cursor))) continue;
		const stat = await lstat(cursor);
		if (stat.isSymbolicLink()) fail("Workspace symlink rejected");
	}
	return target;
}
async function boundedRead(path: string) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE)
			fail("File not regular or exceeds limit");
		const data = await handle.readFile();
		if (data.length > MAX_FILE || data.includes(0)) fail("File exceeds limit or is binary");
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} finally {
		await handle.close();
	}
}
export class WorkspaceDriver {
	readonly root: string;
	private readonly options: WorkspaceDriverOptions;
	private readonly issued = new Map<string, Workspace>();
	private readonly receipts = new WeakMap<CheckReceipt, string>();
	private readonly gitExecutable: string;
	constructor(options: WorkspaceDriverOptions) {
		this.options = { ...options, profiles: structuredClone(options.profiles) };
		this.root = resolve(options.root ?? join(homedir(), ".config/giraffe/worktrees"));
		this.gitExecutable = options.gitExecutable ?? "git";
	}
	private profile(ws: Workspace): RepairProfile & { hooksPath: string } {
		const p = this.options.profiles[ws.repository];
		if (!p?.checks.length || !p.files.length || !p.hooksPath)
			fail("Repository repair profile required");
		for (const c of p.checks)
			if (!/^[A-Za-z0-9:_-]{1,80}$/.test(c)) fail("Invalid configured check");
		for (const f of p.files) fileName(f);
		fileName(p.hooksPath);
		return { ...p, hooksPath: p.hooksPath };
	}
	private sealPath(ws: Workspace) {
		return join(this.root, `${ws.id}.seal.json`);
	}
	private async metadata(ws: Workspace) {
		const gitDir = join(ws.path, ".git");
		if (!(await lstat(gitDir)).isDirectory() || (await lstat(gitDir)).isSymbolicLink())
			fail("Untrusted Git metadata directory");
		const records: Record<string, string> = {};
		let count = 0;
		const walk = async (path: string, protectedFiles: boolean) => {
			const stat = await lstat(path);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				fail("Untrusted Git metadata path");
			if (++count > 50000) fail("Git metadata exceeds safety bound");
			if (stat.isDirectory()) {
				if (protectedFiles) records[relative(ws.path, path)] = "directory";
				for (const name of await readdir(path)) await walk(join(path, name), protectedFiles);
			} else {
				if (stat.nlink !== 1) fail("Untrusted Git metadata hardlink");
				if (protectedFiles)
					records[relative(ws.path, path)] = `${stat.mode & 0o777}:${sha(await boundedRead(path))}`;
			}
		};
		await walk(gitDir, false);
		for (const name of [
			"commondir",
			"gitdir",
			"config.worktree",
			"objects/info/alternates",
			"objects/info/http-alternates",
			"info/grafts",
			"refs/replace",
		])
			if (!(await absent(join(gitDir, name))))
				fail("External or replacement Git metadata forbidden");
		for (const name of ["config", "info", "hooks"]) {
			const path = join(gitDir, name);
			if (await absent(path)) records[`.git/${name}`] = "absent";
			else await walk(path, true);
		}
		const config = await boundedRead(join(gitDir, "config"));
		if (/^\s*\[(?:include|includeIf|extensions)(?:\s|\])/im.test(config))
			fail("Git includes and extensions forbidden");
		const hooks = join(ws.path, this.profile(ws).hooksPath);
		if (await absent(hooks)) records[this.profile(ws).hooksPath] = "absent";
		else await walk(await plainPath(ws.path, this.profile(ws).hooksPath), true);
		return records;
	}
	private async assertSeal(ws: Workspace) {
		if ((await realpath(ws.path)) !== ws.path) fail("Workspace symlink rejected");
		const expected = await boundedRead(this.sealPath(ws));
		if (expected !== JSON.stringify(await this.metadata(ws)))
			fail("Git metadata seal changed; workspace blocked");
	}
	private abort(signal?: AbortSignal) {
		if (signal?.aborted) fail("Repair operation cancelled");
	}
	private async identity(ws: Workspace) {
		const saved = this.issued.get(ws.id);
		if (!saved || JSON.stringify(saved) !== JSON.stringify(ws)) fail("Unknown workspace identity");
		if ((await realpath(ws.path)) !== ws.path || (await lstat(ws.path)).isSymbolicLink())
			fail("Workspace symlink rejected");
		if ((await this.git(ws.path, ["symbolic-ref", "--short", "HEAD"])).trim() !== ws.branch)
			fail("Repair branch changed");
		this.profile(ws);
	}
	private env(home: string) {
		return {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			TMPDIR: home,
			LANG: "C.UTF-8",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_LFS_SKIP_SMUDGE: "1",
			GIT_AUTHOR_NAME: "Giraffe Agent",
			GIT_AUTHOR_EMAIL: "giraffe@users.noreply.github.com",
			GIT_COMMITTER_NAME: "Giraffe Agent",
			GIT_COMMITTER_EMAIL: "giraffe@users.noreply.github.com",
		};
	}
	private async git(cwd: string, args: string[], extra: Record<string, string> = {}) {
		const workspace = [...this.issued.values()].find((value) => value.path === cwd);
		if (workspace && !(await absent(this.sealPath(workspace)))) await this.assertSeal(workspace);
		const home = join(this.root, ".scratch");
		await mkdir(home, { recursive: true, mode: 0o700 });
		try {
			const result = await promisify(execFile)(
				this.gitExecutable,
				[
					"-c",
					"protocol.file.allow=never",
					"-c",
					"protocol.ext.allow=never",
					"-c",
					"core.fsmonitor=false",
					...args,
				],
				{
					cwd,
					env: { ...this.env(home), ...extra },
					encoding: "utf8",
					timeout: 30000,
					maxBuffer: MAX_DIFF,
					killSignal: "SIGKILL",
				},
			);
			return result.stdout;
		} catch {
			fail("Git operation failed or exceeded bounds");
		}
	}
	private async safeTree(ws: Workspace) {
		const raw = await this.git(ws.path, ["ls-tree", "-rz", ws.baseSha]);
		for (const row of raw.split("\0").filter(Boolean)) {
			const mode = row.slice(0, 6);
			const name = row.slice(row.indexOf("\t") + 1);
			if (mode === "120000" || mode === "160000") fail("Symlinks and submodules are unsupported");
			if (name.split("/").some((part) => denied.test(part)))
				fail("Credential paths in repository are unsupported");
			if (name.split("/").some((p) => p === ".gitattributes" || p === ".gitmodules"))
				fail("Git filters and submodules are unsupported");
		}
		const attrs = await this.git(ws.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
		for (const name of attrs.split("\0").filter(Boolean)) {
			fileName(name);
			if (!this.profile(ws).files.includes(name)) fail("Untracked file outside repair allowlist");
		}
	}
	async prepare(input: {
		id: string;
		repository: string;
		baseSha: string;
		defaultBranch: string;
	}): Promise<Workspace> {
		if (
			!/^deps-[A-Za-z0-9][A-Za-z0-9_-]{0,70}$/.test(input.id) ||
			!repositoryPattern.test(input.repository) ||
			!validSha(input.baseSha) ||
			!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(input.defaultBranch) ||
			input.defaultBranch.includes("..")
		)
			fail("Invalid repair identity or base");
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700);
		if ((await realpath(this.root)) !== this.root) fail("Workspace root must not be a symlink");
		const branch = `giraffe/${input.id}`;
		if (branch === input.defaultBranch) fail("Default branch forbidden");
		const path = join(this.root, input.id),
			ws = { ...input, path, branch };
		const normalized: Workspace = {
			id: ws.id,
			repository: ws.repository,
			baseSha: ws.baseSha,
			path: ws.path,
			branch: ws.branch,
		};
		this.profile(normalized);
		if (!(await absent(path))) {
			const state = JSON.parse(await boundedRead(join(this.root, `${input.id}.json`))) as Workspace;
			if (JSON.stringify(state) !== JSON.stringify(normalized))
				fail("Existing workspace identity mismatch");
			this.issued.set(input.id, structuredClone(normalized));
			await this.assertSeal(normalized);
			await this.identity(normalized);
			await this.snapshot(normalized);
			return normalized;
		}
		const source = this.options.localSources?.[input.repository];
		if (source) {
			await this.git(this.root, [
				"-c",
				"protocol.file.allow=always",
				"clone",
				"--no-local",
				"--no-checkout",
				"--template=",
				"--no-recurse-submodules",
				"--",
				resolve(source),
				path,
			]);
		} else {
			await this.transport(
				"clone",
				normalized,
				{
					command: this.gitExecutable,
					args: [
						"clone",
						"--no-local",
						"--no-checkout",
						"--template=",
						"--no-recurse-submodules",
						"--",
						`https://github.com/${input.repository}.git`,
						path,
					],
				},
				this.root,
			);
		}
		this.issued.set(input.id, structuredClone(normalized));
		try {
			await this.safeTree(normalized);
			const base = await this.git(path, [
				"rev-parse",
				`refs/remotes/origin/${input.defaultBranch}^{commit}`,
			]);
			if (base.trim() !== input.baseSha) fail("Default branch base SHA changed");
			await this.git(path, ["checkout", "-b", branch, input.baseSha, "--"]);
			await this.git(path, ["config", "core.hooksPath", this.profile(normalized).hooksPath]);
			await writeFile(this.sealPath(normalized), JSON.stringify(await this.metadata(normalized)), {
				mode: 0o600,
				flag: "wx",
			});
			await writeFile(join(this.root, `${input.id}.json`), JSON.stringify(normalized), {
				mode: 0o600,
				flag: "wx",
			});
			return normalized;
		} catch (error) {
			this.issued.delete(input.id);
			throw error;
		}
	}
	async readFile(ws: Workspace, path: string) {
		await this.identity(ws);
		fileName(path);
		if (
			!this.profile(ws).files.includes(path) &&
			!["README.md", "AGENTS.md", "NOTICE", "LICENSE"].includes(path)
		)
			fail("File outside read allowlist");
		return boundedRead(await plainPath(ws.path, path));
	}
	async writeFile(ws: Workspace, path: string, text: string) {
		await this.identity(ws);
		fileName(path);
		if (
			!this.profile(ws).files.includes(path) ||
			path === this.profile(ws).hooksPath ||
			path.startsWith(`${this.profile(ws).hooksPath}/`)
		)
			fail("File outside write allowlist");
		if (
			["AGENTS.md", "README.md", "NOTICE", "LICENSE"].includes(path) ||
			path.split("/").some((p) => p === ".gitattributes" || p === ".gitmodules")
		)
			fail("Protected provenance file");
		if (path === "package.json") {
			const previous = JSON.parse(
				await this.git(ws.path, ["show", `${ws.baseSha}:package.json`]),
			) as { scripts?: unknown };
			const next = JSON.parse(text) as { scripts?: unknown };
			if (JSON.stringify(previous.scripts) !== JSON.stringify(next.scripts))
				fail("Package scripts cannot be weakened or changed");
		}
		if (Buffer.byteLength(text) > MAX_FILE || text.includes("\0"))
			fail("File exceeds limit or is binary");
		const target = await plainPath(ws.path, path, true);
		await mkdir(dirname(target), { recursive: true });
		await plainPath(ws.path, path, true);
		if (!(await absent(target))) {
			const stat = await lstat(target);
			if (!stat.isFile() || stat.nlink !== 1) fail("Unsafe file");
		}
		const handle = await open(
			target,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(text);
		} finally {
			await handle.close();
		}
	}
	async snapshot(ws: Workspace): Promise<WorkspaceSnapshot> {
		await this.identity(ws);
		await this.recoverCommit(ws);
		return this.capture(ws);
	}
	private async recoverCommit(ws: Workspace) {
		const marker = join(this.root, `${ws.id}.commit.json`);
		if (await absent(marker)) return;
		const value = JSON.parse(await boundedRead(marker)) as {
			beforeHead: string;
			contentFingerprint: string;
			files: string[];
		};
		if (
			!validSha(value.beforeHead) ||
			!Array.isArray(value.files) ||
			value.files.some((file) => !this.profile(ws).files.includes(file))
		)
			fail("Invalid commit intent");
		const snapshot = await this.capture(ws, true);
		if (
			snapshot.contentFingerprint !== value.contentFingerprint ||
			JSON.stringify(snapshot.changedPaths) !== JSON.stringify([...value.files].sort())
		)
			fail("Commit intent content mismatch");
		const staged = (await this.git(ws.path, ["diff", "--cached", "--name-only", "-z"]))
			.split("\0")
			.filter(Boolean);
		if (snapshot.head === value.beforeHead) {
			if (staged.some((file) => !value.files.includes(file))) fail("Commit intent index mismatch");
			if (
				staged.length &&
				(await this.git(ws.path, ["diff", "--name-only", "--", ...staged])).trim()
			)
				fail("Commit intent staged content changed");
			if (staged.length)
				await this.git(ws.path, [
					"restore",
					"--staged",
					"--source",
					value.beforeHead,
					"--",
					...staged,
				]);
		} else {
			const parent = (await this.git(ws.path, ["rev-parse", "HEAD^"])).trim();
			if (
				parent !== value.beforeHead ||
				staged.length ||
				(await this.git(ws.path, ["status", "--porcelain", "--untracked-files=all"])).trim()
			)
				fail("Commit intent head mismatch");
		}
		await rm(marker);
	}
	private async capture(ws: Workspace, allowStaged = false): Promise<WorkspaceSnapshot> {
		await this.identity(ws);
		await this.safeTree(ws);
		if (!allowStaged && (await this.git(ws.path, ["diff", "--cached", "--name-only"])).trim())
			fail("Dirty index rejected");
		const changed = (await this.git(ws.path, ["diff", "--name-only", "-z", ws.baseSha, "--"]))
			.split("\0")
			.filter(Boolean);
		const ignored = (
			await this.git(ws.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
		)
			.split("\0")
			.filter(Boolean);
		if (ignored.some((name) => this.profile(ws).files.includes(name)))
			fail("Allowlisted file is ignored and cannot be reviewed");
		const untracked = (
			await this.git(ws.path, ["ls-files", "--others", "--exclude-standard", "-z"])
		)
			.split("\0")
			.filter(Boolean);
		const changedPaths = [...new Set([...changed, ...untracked])].sort();
		if (changedPaths.length > MAX_FILES) fail("Too many changed files");
		const manifests: WorkspaceSnapshot["manifestBeforeAfter"] = {};
		for (const name of changedPaths) {
			fileName(name);
			if (!this.profile(ws).files.includes(name)) fail("Changed file outside allowlist");
			const path = await plainPath(ws.path, name, true);
			const after = (await absent(path)) ? null : await boundedRead(path);
			if (name.endsWith("package.json")) {
				let before: string | null = null;
				try {
					before = await this.git(ws.path, ["show", `${ws.baseSha}:${name}`]);
				} catch {}
				manifests[name] = { before, after };
			}
		}
		const scratch = join(this.root, ".scratch");
		const index = join(scratch, `index-${sha(ws.id)}`);
		await rm(index, { force: true });
		const extra = { GIT_INDEX_FILE: index };
		try {
			await this.git(ws.path, ["read-tree", "HEAD"], extra);
			if (changedPaths.length) await this.git(ws.path, ["add", "--", ...changedPaths], extra);
			const tree = (await this.git(ws.path, ["write-tree"], extra)).trim();
			const baseTree = (await this.git(ws.path, ["rev-parse", `${ws.baseSha}^{tree}`])).trim();
			const diff = await this.git(ws.path, [
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--binary",
				ws.baseSha,
				tree,
				"--",
			]);
			if (Buffer.byteLength(diff) > 40 * 1024) fail("Complete review diff exceeds 40 KiB");
			if (diff.includes("GIT binary patch")) fail("Binary diff rejected");
			const diffDigest = sha(diff);
			return {
				head: (await this.git(ws.path, ["rev-parse", "HEAD"])).trim(),
				tree,
				baseTree,
				diffDigest,
				contentFingerprint: sha(JSON.stringify({ baseTree, tree, diffDigest })),
				changedPaths,
				diff,
				manifestBeforeAfter: manifests,
				complete: true,
			};
		} finally {
			await rm(index, { force: true });
		}
	}
	private async baselinePolicy(ws: Workspace) {
		const profile = this.profile(ws);
		const baseline = JSON.parse(
			await this.git(ws.path, ["show", `${ws.baseSha}:package.json`]),
		) as { scripts?: Record<string, unknown> };
		const current = JSON.parse(await boundedRead(await plainPath(ws.path, "package.json"))) as {
			scripts?: Record<string, unknown>;
		};
		if (JSON.stringify(baseline.scripts) !== JSON.stringify(current.scripts))
			fail("Package scripts cannot be weakened or changed");
		for (const name of profile.checks)
			if (typeof baseline.scripts?.[name] !== "string" || !baseline.scripts[name])
				fail("Configured check missing from baseline scripts");
		const hook = await plainPath(ws.path, `${profile.hooksPath}/pre-commit`);
		const stat = await lstat(hook);
		if (!stat.isFile() || !(stat.mode & 0o111) || stat.size === 0)
			fail("Required pre-commit hook unavailable");
		const before = await this.git(ws.path, [
			"show",
			`${ws.baseSha}:${profile.hooksPath}/pre-commit`,
		]);
		if ((await boundedRead(hook)) !== before) fail("Required hook changed");
	}
	private async sandbox(
		ws: Workspace,
		operation: SandboxRequest["purpose"],
		command: CheckCommand,
		stdin?: string,
		signal?: AbortSignal,
	) {
		this.abort(signal);
		await this.assertSeal(ws);
		const runner = this.options.sandbox;
		if (
			!runner?.verified ||
			!runner.capabilities.filesystem ||
			!runner.capabilities.network ||
			!runner.capabilities.resourceLimits
		)
			fail("Verified sandbox runner required");
		const scratch = join(this.root, ".scratch", ws.id);
		await mkdir(scratch, { recursive: true, mode: 0o700 });
		let result: Awaited<ReturnType<SandboxRunner["run"]>>;
		try {
			result = await runner.run({
				purpose: operation,
				...(signal ? { signal } : {}),
				...(stdin === undefined ? {} : { stdin }),
				workspace: ws,
				argv: [command.command, ...command.args],
				timeoutMs: 120000,
			});
		} catch {
			fail("Sandbox runner failed");
		} finally {
			await this.assertSeal(ws);
		}
		this.abort(signal);
		if (
			result.exitCode !== 0 ||
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_DIFF
		) {
			throw new WorkspaceError(
				"Sandbox operation failed or exceeded bounds",
				operation === "check" || operation === "install"
					? `${result.stdout}\n${result.stderr}`
					: undefined,
			);
		}
		return result;
	}
	async check(
		ws: Workspace,
		input: { contentFingerprint: string; commands?: string[]; signal?: AbortSignal },
	): Promise<CheckReceipt> {
		this.abort(input.signal);
		const before = await this.snapshot(ws);
		await this.baselinePolicy(ws);
		if (before.contentFingerprint !== input.contentFingerprint) fail("Stale check snapshot");
		const commands = this.profile(ws).checks;
		if (input.commands && JSON.stringify(input.commands) !== JSON.stringify(commands))
			fail("Only configured checks allowed");
		const results: CheckReceipt["results"] = [];
		for (const name of commands) {
			const output = await this.sandbox(
				ws,
				"check",
				{
					command: this.profile(ws).manager,
					args: ["run", name],
				},
				undefined,
				input.signal,
			);
			results.push({ command: name, exitCode: 0, stdout: output.stdout, stderr: output.stderr });
		}
		if ((await this.snapshot(ws)).contentFingerprint !== before.contentFingerprint)
			fail("Checks changed repository contents");
		const receipt = {
			contentFingerprint: before.contentFingerprint,
			commands: structuredClone(commands),
			results,
			validationDigest: sha(
				JSON.stringify({
					contentFingerprint: before.contentFingerprint,
					commands,
					exitCodes: results.map((result) => result.exitCode),
					scripts: JSON.parse(await this.git(ws.path, ["show", `${ws.baseSha}:package.json`]))
						.scripts,
				}),
			),
		};
		this.receipts.set(receipt, JSON.stringify(receipt));
		return receipt;
	}
	async updateDependency(
		ws: Workspace,
		input: {
			manifest: string;
			section: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
			name: string;
			version: string;
		},
	) {
		const before = await this.snapshot(ws);
		await this.baselinePolicy(ws);

		if (
			input.manifest !== "package.json" ||
			!["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].includes(
				input.section,
			) ||
			!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(input.name) ||
			!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version)
		)
			fail("Invalid exact dependency target");
		const original = await this.readFile(ws, input.manifest);
		const manifest = JSON.parse(original) as Record<string, unknown>;
		const section = manifest[input.section];
		if (
			!section ||
			typeof section !== "object" ||
			Array.isArray(section) ||
			!Object.hasOwn(section, input.name)
		)
			fail("Dependency not present");
		const manager = this.profile(ws).manager;
		const lock = manager === "npm" ? "package-lock.json" : "bun.lock";
		if (!this.profile(ws).files.includes(lock)) fail("Lockfile must be allowlisted");
		const oldLock = await this.readFile(ws, lock);
		if (before.changedPaths.length) {
			const base = JSON.parse(
				await this.git(ws.path, ["show", `${ws.baseSha}:${input.manifest}`]),
			) as Record<string, unknown>;
			const target = base[input.section];
			if (!target || typeof target !== "object" || Array.isArray(target))
				fail("Dependency not present in baseline");
			(target as Record<string, unknown>)[input.name] = input.version;
			if (
				before.changedPaths.some((path) => path !== input.manifest && path !== lock) ||
				JSON.stringify(base) !== JSON.stringify(manifest)
			)
				fail("Dependency replay differs from intended update");
		}

		(section as Record<string, unknown>)[input.name] = input.version;
		try {
			await this.writeFile(ws, input.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
			await this.sandbox(ws, "install", {
				command: manager,
				args:
					manager === "npm"
						? ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
						: ["install", "--ignore-scripts"],
			});
			const after = await this.snapshot(ws);
			if (after.changedPaths.some((p) => p !== input.manifest && p !== lock))
				fail("Install modified unexpected files");
			return after;
		} catch (error) {
			await this.writeFile(ws, input.manifest, original);
			await this.writeFile(ws, lock, oldLock);
			throw error;
		}
	}
	private checkReceipt(receipt: CheckReceipt, fingerprint: string) {
		if (
			this.receipts.get(receipt) !== JSON.stringify(receipt) ||
			receipt.contentFingerprint !== fingerprint
		)
			fail("Checks are not valid for this content");
	}
	async commit(
		ws: Workspace,
		input: {
			contentFingerprint: string;
			files: string[];
			message: string;
			checks: CheckReceipt;
			signal?: AbortSignal;
		},
	) {
		const before = await this.snapshot(ws);
		if (before.contentFingerprint !== input.contentFingerprint) fail("Stale commit snapshot");
		this.checkReceipt(input.checks, before.contentFingerprint);
		if (
			before.head !== ws.baseSha &&
			!(await this.git(ws.path, ["status", "--porcelain", "--untracked-files=all"])).trim()
		)
			return before;
		if (
			!input.message ||
			input.message.length > 200 ||
			input.message.includes("\n") ||
			JSON.stringify([...input.files].sort()) !== JSON.stringify(before.changedPaths) ||
			!before.changedPaths.length
		)
			fail("Commit must name every changed file explicitly");
		const hooks = this.profile(ws).hooksPath;
		await plainPath(ws.path, hooks);
		if ((await this.git(ws.path, ["config", "--get", "core.hooksPath"])).trim() !== hooks)
			fail("Required hooks not configured");
		this.abort(input.signal);
		await this.baselinePolicy(ws);
		const marker = join(this.root, `${ws.id}.commit.json`);
		const handle = await open(marker, "wx", 0o600);
		try {
			await handle.writeFile(
				JSON.stringify({
					beforeHead: before.head,
					contentFingerprint: before.contentFingerprint,
					files: input.files,
				}),
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await this.git(ws.path, ["add", "--", ...input.files]);
			await this.sandbox(
				ws,
				"commit",
				{
					command: this.gitExecutable,
					args: ["commit", "-m", input.message, "--", ...input.files],
				},
				undefined,
				input.signal,
			);
		} catch (error) {
			await this.recoverCommit(ws);
			throw error;
		}

		const after = await this.snapshot(ws);
		if (after.contentFingerprint !== before.contentFingerprint)
			fail("Commit hook changed reviewed content");
		return after;
	}
	private async transport(
		operation: GitTransportRequest["operation"],
		ws: Workspace,
		command: CheckCommand,
		cwd = ws.path,
		signal?: AbortSignal,
	) {
		this.abort(signal);
		if (operation !== "clone") await this.assertSeal(ws);
		const fn = this.options.gitTransport;
		if (!fn) fail("Host Git transport required");
		let result: Awaited<ReturnType<HostGitTransport>>;
		try {
			result = await fn({
				operation,
				repository: ws.repository,
				command,
				cwd,
				timeoutMs: 120000,
				maxOutputBytes: MAX_DIFF,
				...(signal ? { signal } : {}),
			});
		} catch {
			fail("Host Git transport failed");
		}
		if (
			result.exitCode ||
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_DIFF
		)
			fail("Host Git transport failed");
		return result.stdout.trim();
	}
	async push(
		ws: Workspace,
		input: {
			head: string;
			contentFingerprint: string;
			signoff: ReviewSignoff;
			checks: CheckReceipt;
			signal?: AbortSignal;
		},
	) {
		this.abort(input.signal);
		const snapshot = await this.snapshot(ws);
		await this.baselinePolicy(ws);
		this.checkReceipt(input.checks, snapshot.contentFingerprint);
		if (
			!validSha(input.head) ||
			snapshot.head !== input.head ||
			snapshot.contentFingerprint !== input.contentFingerprint ||
			input.signoff.head !== input.head ||
			input.signoff.contentFingerprint !== snapshot.contentFingerprint ||
			input.signoff.validationDigest !== input.checks.validationDigest
		)
			fail("Exact-code signoff required");
		if ((await this.git(ws.path, ["status", "--porcelain", "--untracked-files=all"])).trim())
			fail("Push requires clean workspace");
		const url = `https://github.com/${ws.repository}.git`;
		if (!ws.branch.startsWith("giraffe/deps-")) fail("Invalid repair ref");
		const read = () =>
			this.transport(
				"remoteHead",
				ws,
				{
					command: this.gitExecutable,
					args: ["ls-remote", "--refs", url, `refs/heads/${ws.branch}`],
				},
				join(this.root, ".scratch"),
				input.signal,
			);
		const remote = await read();
		if (remote) {
			if (remote.split(/\s+/)[0] === input.head)
				return { head: input.head, branch: ws.branch, reconciled: true };
			fail("Remote branch already differs");
		}
		const hookPath = await plainPath(ws.path, `${this.profile(ws).hooksPath}/pre-push`);
		const hook = await lstat(hookPath);
		if (!hook.isFile() || !hook.size || !(hook.mode & 0o111))
			fail("Required pre-push hook unavailable");
		if (
			(await boundedRead(hookPath)) !==
			(await this.git(ws.path, ["show", `${ws.baseSha}:${this.profile(ws).hooksPath}/pre-push`]))
		)
			fail("Pre-push hook changed");
		await this.sandbox(
			ws,
			"prepush",
			{ command: hookPath, args: ["origin", url] },
			`refs/heads/${ws.branch} ${input.head} refs/heads/${ws.branch} ${"0".repeat(40)}\n`,
			input.signal,
		);
		const checked = await this.snapshot(ws);
		if (
			checked.head !== input.head ||
			checked.contentFingerprint !== input.contentFingerprint ||
			(await this.git(ws.path, ["status", "--porcelain", "--untracked-files=all"])).trim()
		)
			fail("Pre-push changed signed content");
		if (await read()) fail("Remote branch changed during hooks");
		const publication = join(this.root, ".scratch", `publish-${ws.id}-${input.head}`);
		if (!(await absent(publication))) fail("Publication scratch already exists");
		try {
			this.abort(input.signal);
			await this.assertSeal(ws);
			await this.git(this.root, [
				"-c",
				"protocol.file.allow=always",
				"clone",
				"--bare",
				"--no-local",
				"--template=",
				"--",
				ws.path,
				publication,
			]);
			await this.transport(
				"push",
				ws,
				{
					command: this.gitExecutable,
					args: ["push", url, `${input.head}:refs/heads/${ws.branch}`],
				},
				publication,
				input.signal,
			);
		} finally {
			await rm(publication, { recursive: true, force: true });
		}
		if ((await read()).split(/\s+/)[0] !== input.head) fail("Remote push not confirmed");
		return { head: input.head, branch: ws.branch, reconciled: false };
	}
}
