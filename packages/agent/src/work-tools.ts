import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { githubRead } from "./github.ts";
import { latestPackage } from "./work-packages.ts";
import type { WorkItem } from "./work-priority.ts";
import { gatePolicyContent, type WorkInspection, type WorkWorkspace } from "./work-workspace.ts";

export async function verifyWorkIssues(
	repository: string,
	issues: (WorkItem & { kind?: "issue" | "pr" })[],
) {
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
				!!live.pull_request !== (issue.kind === "pr") ||
				(issue.kind === "pr" && !live.title.startsWith("[CO]")) ||
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
			if (operation === "latest")
				return latestPackage(z.string().parse(raw.name), driver.packageRegistry);
			if (operation === "satisfied") {
				const args = z.object({ issue: z.number().int(), name: z.string() }).parse(raw);
				if (args.issue !== issues.find((issue) => !committed.some((done) => done.issue === issue)))
					throw new Error("Verification must cover the next assigned issue.");
				const metadata = await latestPackage(args.name, driver.packageRegistry);
				const manifest = JSON.parse(
					await readFile(resolve(workspace.path, "package.json"), "utf8"),
				);
				const declared = [
					"dependencies",
					"devDependencies",
					"optionalDependencies",
					"overrides",
				].some((section) => manifest[section]?.[args.name] === metadata.version);
				const lock = await readFile(
					resolve(workspace.path, workspace.manager === "bun" ? "bun.lock" : "package-lock.json"),
					"utf8",
				);
				const locked =
					workspace.manager === "bun"
						? lock.includes(
								`${JSON.stringify(args.name)}: [${JSON.stringify(`${args.name}@${metadata.version}`)},`,
							)
						: JSON.parse(lock).packages?.[`node_modules/${args.name}`]?.version ===
							metadata.version;
				const current = await driver.inspect(workspace.repository);
				if (
					!declared ||
					!locked ||
					current.status !== workspace.status ||
					current.diff !== workspace.diff
				)
					throw new Error(
						"Already-current verification requires exact latest manifest/lock and no pending changes.",
					);
				await driver.check(workspace, signal);
				committed.push({ issue: args.issue, head: current.head });
				return { alreadyCurrent: true, head: current.head, version: metadata.version };
			}
			if (operation === "read" || operation === "write") {
				const name = z.string().parse(raw.path);
				const path = await safePath(workspace.path, name);
				if (operation === "read") {
					const content = await readFile(path, "utf8");
					if (Buffer.byteLength(content) > 256000) throw new Error("File exceeds worker budget.");
					const match = raw.match === undefined ? undefined : z.string().min(1).parse(raw.match);
					const offset =
						match === undefined
							? z
									.number()
									.int()
									.nonnegative()
									.parse(raw.offset ?? 0)
							: content.indexOf(match);
					if (offset < 0) throw new Error("Literal match not found in file.");
					const limit = z
						.number()
						.int()
						.min(1)
						.max(16000)
						.parse(raw.limit ?? 16000);
					return {
						content: content.slice(offset, offset + limit),
						...(content.length > limit || offset
							? {
									total: content.length,
									offset,
									nextOffset: offset + limit < content.length ? offset + limit : null,
								}
							: {}),
					};
				}
				const content = z.string().max(256000).parse(raw.content);
				const schemaOnly =
					/^biome\.jsonc?$/.test(name) &&
					gatePolicyContent(name, await readFile(path, "utf8")) ===
						gatePolicyContent(name, content);
				if (dirtyPaths.some((dirty) => name === dirty || name.startsWith(`${dirty}/`)))
					throw new Error("Worker cannot overwrite pre-existing dirty files.");
				if (
					name === "AGENTS.md" ||
					name.startsWith(".husky/") ||
					(name.startsWith(".github/") && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) ||
					(/(?:vitest|biome|eslint|tsconfig|jest|coverage)/.test(name) && !schemaOnly)
				)
					throw new Error(
						"Worker cannot weaken tests or hooks; workflow repairs must be narrowly relevant.",
					);
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
						issues: z.array(z.number().int().positive()).min(1),
						files: z.array(z.string()).min(1),
						message: z
							.string()
							.max(50)
							.regex(/^(fix|feat|chore|refactor|test|docs): [a-z0-9].*$/),
					})
					.parse(raw);
				const pending = issues.filter((issue) => !committed.some((done) => done.issue === issue));
				const remaining = pending.length ? pending : issues;
				if (
					(pending.length > 0 && args.issues[0] !== remaining[0]) ||
					new Set(args.issues).size !== args.issues.length ||
					args.issues.some((issue) => !remaining.includes(issue)) ||
					args.files.some((path) => !written.has(path))
				)
					throw new Error(
						"Commit must contain only this worker's files and the next assigned issue.",
					);
				await driver.check(workspace, signal);
				const head = await driver.commit(workspace, args.files, args.message, signal);
				for (const issue of args.issues) {
					const previous = committed.find((done) => done.issue === issue);
					if (previous) previous.head = head;
					else committed.push({ issue, head });
				}
				written.clear();
				return { head };
			}
			throw new Error("Operation is not permitted for workers.");
		},
	};
}
