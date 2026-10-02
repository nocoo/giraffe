import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { githubRead } from "./repair-source.ts";
import type { WorkItem } from "./work-priority.ts";
import type { WorkInspection, WorkWorkspace } from "./work-workspace.ts";

export async function verifyWorkIssues(repository: string, issues: WorkItem[]) {
	const owner = repository.split("/")[0];
	const identity = z.object({ login: z.string() }).parse(await githubRead("user"));
	const repo = z
		.object({
			full_name: z.string(),
			owner: z.object({ login: z.string() }),
			fork: z.boolean(),
			archived: z.boolean(),
			default_branch: z.string(),
		})
		.parse(await githubRead(`repos/${repository}`));
	if (
		identity.login !== owner ||
		repo.owner.login !== owner ||
		repo.full_name !== repository ||
		repo.fork ||
		repo.archived ||
		repo.default_branch !== "main"
	)
		throw new Error("Live repository is outside the owned main execution scope.");
	return Promise.all(
		issues.map(async (issue) => {
			const live = z
				.object({
					number: z.number(),
					state: z.string(),
					title: z.string(),
					body: z.string().nullable(),
					updated_at: z.string(),
					pull_request: z.unknown().optional(),
				})
				.parse(await githubRead(`repos/${repository}/issues/${issue.number}`));
			if (
				live.number !== issue.number ||
				live.state !== "open" ||
				live.pull_request ||
				live.updated_at !== issue.updatedAt
			)
				throw new Error(`Issue #${issue.number} changed; refresh Giraffe and re-plan.`);
			return { ...issue, body: live.body };
		}),
	);
}

async function safePath(root: string, name: string) {
	if (
		!name ||
		isAbsolute(name) ||
		name
			.split(/[\\/]/)
			.some(
				(part) =>
					part === ".." ||
					part === ".git" ||
					part === "node_modules" ||
					/^(\.env|\.dev\.vars|credentials|config\.json$)/i.test(part),
			)
	)
		throw new Error("Unsafe workspace file.");
	root = await realpath(root);
	const target = resolve(root, name);
	const parent = await realpath(dirname(target));
	if (parent !== root && !parent.startsWith(`${root}${sep}`))
		throw new Error("Workspace path escaped root.");
	try {
		if ((await realpath(target)) !== target)
			throw new Error("Symlink workspace file is not editable.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return target;
}

export function workerActions(
	driver: WorkWorkspace,
	workspace: WorkInspection,
	issues: number[],
	signal?: AbortSignal,
) {
	const committed: { issue: number; head: string }[] = [];
	const written = new Set<string>();
	const dirtyPaths = workspace.status
		.split("\n")
		.filter(Boolean)
		.flatMap((line) =>
			line
				.slice(3)
				.split(" -> ")
				.map((name) => (name.startsWith('"') ? (JSON.parse(name) as string) : name)),
		);
	return {
		committed,
		async action(operation: string, raw: Record<string, unknown>) {
			if (signal?.aborted) throw new Error("Worker cancelled.");
			if (operation === "read" || operation === "write") {
				const name = z.string().parse(raw.path);
				const path = await safePath(workspace.path, name);
				if (operation === "read") {
					const content = await readFile(path, "utf8");
					if (Buffer.byteLength(content) > 256000) throw new Error("File exceeds worker budget.");
					return { content };
				}
				const content = z.string().max(256000).parse(raw.content);
				if (dirtyPaths.some((dirty) => name === dirty || name.startsWith(`${dirty}/`)))
					throw new Error("Worker cannot overwrite pre-existing dirty files.");
				if (
					name === "AGENTS.md" ||
					name.startsWith(".husky/") ||
					name.startsWith(".github/") ||
					/(?:vitest|biome|eslint|tsconfig|jest|coverage)/.test(name)
				)
					throw new Error("Worker cannot weaken baseline instructions or gates.");
				if (name === "package.json") {
					const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
					const after = JSON.parse(content) as Record<string, unknown>;
					if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts))
						throw new Error("Worker cannot change baseline check scripts.");
				}
				await writeFile(path, content);
				written.add(relative(await realpath(workspace.path), path));
				return { written: name };
			}
			if (operation === "check") {
				await driver.check(workspace, signal);
				return { passed: true };
			}
			if (operation === "install") {
				await driver.install(workspace, signal);
				const current = await driver.inspect(workspace.repository);
				for (const line of current.status.split("\n")) {
					const file = line.slice(3);
					if (["bun.lock", "package-lock.json"].includes(file) && !dirtyPaths.includes(file))
						written.add(file);
				}
				return { installed: true };
			}
			if (operation === "commit") {
				const args = z
					.object({
						issue: z.number().int(),
						files: z.array(z.string()).min(1),
						message: z.string().min(1).max(200),
					})
					.parse(raw);
				if (
					args.issue !== issues[committed.length] ||
					args.files.some((path) => !written.has(path))
				)
					throw new Error(
						"Commit must contain only this worker's files and the next assigned issue.",
					);
				await driver.check(workspace, signal);
				const head = await driver.commit(workspace, args.files, args.message, signal);
				committed.push({ issue: args.issue, head });
				written.clear();
				return { head };
			}
			throw new Error("Operation is not permitted for workers.");
		},
	};
}
