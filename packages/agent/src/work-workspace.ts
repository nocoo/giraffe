import { constants } from "node:fs";
import { access, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { repositorySchema } from "./contracts.ts";
import { digest } from "./evidence.ts";
import { type LocalRunner, runLocal } from "./repair-local.ts";
import { safeDiagnostics } from "./repair-workspace.ts";

export type WorkInspection = {
	repository: string;
	path: string;
	branch: string;
	head: string;
	status: string;
	diff: string;
	ahead: number;
	behind: number;
	checks: string[];
	manager: "bun" | "npm";
	instructions: string;
	policy: string;
	hooksPath: string;
};
const blockedFile = (name: string) =>
	!name ||
	name.startsWith("/") ||
	name.startsWith("-") ||
	name
		.split(/[\\/]/)
		.some(
			(part) =>
				part === ".." ||
				part === ".git" ||
				/^(\.env|\.dev\.vars|credentials|.*\.(pem|key)$)/i.test(part),
		);
const dirtyFiles = (status: string) =>
	status
		.split("\n")
		.filter(Boolean)
		.flatMap((line) =>
			line
				.slice(3)
				.split(" -> ")
				.map((name) => (name.startsWith('"') ? (JSON.parse(name) as string) : name)),
		);

export function gatePolicyContent(name: string, content: string) {
	return /^biome\.jsonc?$/.test(name)
		? content.replace(
				/("\$schema"\s*:\s*)"https:\/\/biomejs\.dev\/schemas\/[0-9]+\.[0-9]+\.[0-9]+\/schema\.json"/,
				'$1"biome-schema"',
			)
		: content;
}

export async function normalizeBunMirror(path: string) {
	const file = join(path, "bun.lock");
	const content = await readFile(file, "utf8");
	const normalized = content.replace(
		/(\["[^"\n]+", )"https:\/\/(?:mirrors\.tencent\.com|packagefeedproxy\.microsoft\.io)\/npm\/[^"\n]+"/g,
		'$1""',
	);
	if (normalized !== content) await writeFile(file, normalized);
}

export class WorkWorkspace {
	private readonly root: string;
	private readonly run: LocalRunner;
	private readonly registry: string;
	private readonly log: (line: string) => void;
	constructor(
		options: {
			root?: string;
			run?: LocalRunner;
			registry?: string;
			log?: (line: string) => void;
		} = {},
	) {
		this.root = options.root ?? join(homedir(), "workspace/personal");
		this.run = options.run ?? runLocal;
		this.registry = options.registry ?? "https://packagefeedproxy.microsoft.io/npm/";
		this.log = options.log ?? (() => {});
	}
	get packageRegistry() {
		return this.registry;
	}
	private async command(path: string, command: string, args: string[], signal?: AbortSignal) {
		const visible =
			command !== "git" || ["fetch", "pull", "commit", "push", "switch"].includes(args[0] ?? "");
		if (visible) this.log(`[本机执行] ${path} $ ${command} ${args.join(" ")}`);
		const result = await this.run({
			command,
			args,
			cwd: path,
			timeoutMs: 600000,
			maxOutputBytes: 1024 * 1024,
			env: {
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				GH_PROMPT_DISABLED: "1",
				BUN_CONFIG_REGISTRY: this.registry,
				NPM_CONFIG_REGISTRY: this.registry,
			},
			...(signal ? { signal } : {}),
		});
		const diagnostics = safeDiagnostics(
			stripVTControlCharacters(`${result.stdout}\n${result.stderr}`)
				.split("\n")
				.slice(-60)
				.join("\n")
				.slice(-5000),
		);
		if (visible) this.log(`[执行结果] exit=${result.exitCode}\n${diagnostics}`);
		if (result.exitCode)
			throw new Error(`${command} ${args[0] ?? ""} failed in ${path}: ${diagnostics}`);
		return result.stdout.replace(/\n$/, "");
	}
	async inspect(repository: string): Promise<WorkInspection> {
		repositorySchema.parse(repository);
		const name = repository.split("/")[1] as string;
		if (name === "." || name === "..") throw new Error("Unsafe repository path.");
		const root = await realpath(this.root);
		const intended = join(root, name);
		if ((await lstat(intended)).isSymbolicLink())
			throw new Error("Repository directory is a symlink.");
		const path = await realpath(intended);
		if (!path.startsWith(`${root}${sep}`) || path !== intended)
			throw new Error("Repository escaped personal root.");
		const git = (...args: string[]) => this.command(path, "git", args);
		if ((await realpath(await git("rev-parse", "--show-toplevel"))) !== path)
			throw new Error("Not an independent repository root.");
		const origin = await git("remote", "get-url", "origin");
		if (
			![
				`git@github.com:${repository}`,
				`https://github.com/${repository}`,
				`ssh://git@github.com/${repository}`,
			].some((url) => origin === url || origin === `${url}.git`)
		)
			throw new Error("Git origin does not match requested GitHub repository.");
		const manifest = z
			.object({ scripts: z.record(z.string(), z.string()) })
			.parse(JSON.parse(await readFile(join(path, "package.json"), "utf8")));
		const test = ["test:unit:coverage", "test:coverage", "test:unit", "test"].find(
			(script) => manifest.scripts[script],
		);
		if (!test || !manifest.scripts.lint)
			throw new Error("Missing root unit-test/coverage or lint scripts.");
		const checks = [
			test,
			"lint",
			...(manifest.scripts.typecheck ? ["typecheck"] : []),
			...(manifest.scripts.build ? ["build"] : []),
		];
		let manager: "bun" | "npm" = "npm";
		try {
			await access(join(path, "bun.lock"));
			manager = "bun";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const branch = await git("branch", "--show-current");
		const head = await git("rev-parse", "HEAD");
		const status = await git("status", "--porcelain=v1", "--untracked-files=all");
		const dirty = dirtyFiles(status);
		if (dirty.some(blockedFile))
			throw new Error("Dirty credential or unsafe paths cannot be sent to models.");
		const tracked = await git("ls-files");
		const paths = tracked.split("\n").filter((file) => file && !blockedFile(file));
		let diff = paths.length ? await git("diff", "HEAD", "--", ...paths) : "";
		for (const line of status.split("\n").filter((entry) => entry.startsWith("?? "))) {
			const file = dirtyFiles(line)[0] as string;
			const filePath = join(path, file);
			if ((await lstat(filePath)).isSymbolicLink())
				throw new Error("Untracked symlink cannot be reviewed.");
			diff += `\nUntracked ${file}:\n${await readFile(filePath, "utf8")}`;
		}
		if (
			Buffer.byteLength(diff) > 128000 ||
			/-----BEGIN .*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{24,})/.test(diff)
		)
			throw new Error("Dirty diff exceeds safe review budget or contains credential material.");
		const counts = (await git("rev-list", "--left-right", "--count", "HEAD...origin/main"))
			.trim()
			.split(/\s+/)
			.map(Number);
		if (counts.length !== 2 || counts.some((count) => !Number.isInteger(count) || count < 0))
			throw new Error("Invalid main tracking state.");
		const hooksPath = await git("config", "--get", "core.hooksPath");
		if (!hooksPath || hooksPath.startsWith("/") || hooksPath.split("/").includes(".."))
			throw new Error("Local executable Git hooks are required.");
		const hooks: string[] = [];
		for (const hook of ["pre-commit", "pre-push"]) {
			const file = join(path, hooksPath, hook);
			await access(file, constants.X_OK);
			hooks.push(await readFile(file, "utf8"));
		}
		for (const file of paths.filter(
			(file) =>
				file.startsWith(".husky/") || /(?:vitest|biome|eslint|tsconfig|jest|coverage)/.test(file),
		)) {
			const target = join(path, file);
			if (!(await lstat(target)).isSymbolicLink())
				hooks.push(`${file}\n${gatePolicyContent(file, await readFile(target, "utf8"))}`);
		}
		const instructions = await readFile(join(path, "AGENTS.md"), "utf8");
		return {
			repository,
			path,
			branch,
			head,
			status,
			diff,
			ahead: counts[0] as number,
			behind: counts[1] as number,
			checks,
			manager,
			instructions,
			hooksPath,
			policy: digest({ scripts: manifest.scripts, hooksPath, hooks, instructions }),
		};
	}
	private async policy(inspection: WorkInspection) {
		const current = await this.inspect(inspection.repository);
		if (current.policy !== inspection.policy || current.path !== inspection.path)
			throw new Error("Baseline check scripts/hooks/instructions changed.");
		return current;
	}
	async install(inspection: WorkInspection, signal?: AbortSignal): Promise<void> {
		await this.policy(inspection);
		await this.command(
			inspection.path,
			inspection.manager,
			inspection.manager === "bun" ? ["install"] : ["install", "--no-audit", "--no-fund"],
			signal,
		);
		if (inspection.manager === "bun") await normalizeBunMirror(inspection.path);
		await this.policy(inspection);
	}
	async files(inspection: WorkInspection): Promise<string[]> {
		await this.policy(inspection);
		return (await this.command(inspection.path, "git", ["ls-files"]))
			.split("\n")
			.filter((file) => file && !blockedFile(file));
	}
	async changes(inspection: WorkInspection): Promise<string> {
		const output = await this.command(inspection.path, "git", ["diff", "origin/main", "HEAD"]);
		if (Buffer.byteLength(output) > 128000)
			throw new Error("Review diff exceeds budget; no publication.");
		return safeDiagnostics(output);
	}
	async check(inspection: WorkInspection, signal?: AbortSignal): Promise<void> {
		await this.policy(inspection);
		for (const script of inspection.checks)
			await this.command(inspection.path, inspection.manager, ["run", script], signal);
		await this.policy(inspection);
	}
	async prepare(
		inspection: WorkInspection,
		retainChanges: boolean,
		signal?: AbortSignal,
	): Promise<WorkInspection> {
		let current = await this.policy(inspection);
		if (
			current.status !== inspection.status ||
			current.diff !== inspection.diff ||
			current.head !== inspection.head
		)
			throw new Error("Workspace changed since controller review.");
		if (current.status && (!retainChanges || current.behind || current.branch !== "main"))
			throw new Error(
				"Dirty workspace cannot be safely prepared; retain grant/main/up-to-date required.",
			);
		if (current.branch !== "main")
			await this.command(current.path, "git", ["switch", "main"], signal);
		await this.command(current.path, "git", ["fetch", "origin", "main"], signal);
		const fetched = await this.policy(inspection);
		if (current.status && fetched.behind)
			throw new Error("Remote advanced while dirty; preserve user work and re-plan.");
		if (!current.status)
			await this.command(current.path, "git", ["pull", "--ff-only", "origin", "main"], signal);
		current = await this.inspect(inspection.repository);
		await this.command(
			current.path,
			current.manager,
			current.manager === "bun"
				? ["install", "--frozen-lockfile"]
				: ["ci", "--no-audit", "--no-fund"],
			signal,
		);
		await this.check(current, signal);
		const after = await this.policy(current);
		if (after.status !== current.status || after.diff !== current.diff)
			throw new Error("Baseline install/check modified files; review them before handing off.");
		return after;
	}
	async commit(
		inspection: WorkInspection,
		files: string[],
		message: string,
		signal?: AbortSignal,
	): Promise<string> {
		const current = await this.policy(inspection);
		if (
			current.branch !== "main" ||
			!files.length ||
			files.some((file) => blockedFile(file) || dirtyFiles(inspection.status).includes(file))
		)
			throw new Error("Commit must preserve baseline files on main.");
		if (current.status.split("\n").some((line) => line && line[0] !== " " && line[0] !== "?"))
			throw new Error("Existing staged changes require owner review.");
		for (const file of files) {
			const full = await realpath(join(current.path, file));
			if (full !== resolve(current.path, file) || !full.startsWith(`${current.path}${sep}`))
				throw new Error("Unsafe commit path.");
		}
		await this.command(current.path, "git", ["add", "--", ...files], signal);
		await this.command(current.path, "git", ["commit", "-m", message], signal);
		return this.command(current.path, "git", ["rev-parse", "HEAD"], signal);
	}
	async publish(
		inspection: WorkInspection,
		expectedHead: string,
		issues: number[],
		signal?: AbortSignal,
	): Promise<void> {
		const verify = async () => {
			const current = await this.policy(inspection);
			if (
				current.branch !== "main" ||
				current.head !== expectedHead ||
				current.status !== inspection.status ||
				current.diff !== inspection.diff
			)
				throw new Error("Publication must match verified HEAD and retained baseline changes.");
			return current;
		};
		const current = await verify();
		if (!issues.length || issues.some((issue) => !Number.isInteger(issue) || issue < 1))
			throw new Error("Invalid issue closure scope.");
		await this.check(current, signal);
		await verify();
		await this.command(current.path, "git", ["push", "origin", "HEAD:main"], signal);
		const remote = await this.command(
			current.path,
			"git",
			["ls-remote", "origin", "refs/heads/main"],
			signal,
		);
		if (remote.split(/\s+/)[0] !== expectedHead)
			throw new Error("Remote main did not verify; no issues closed.");
		for (const issue of issues)
			await this.command(
				current.path,
				"gh",
				["issue", "close", String(issue), "--repo", current.repository],
				signal,
			);
	}
}
