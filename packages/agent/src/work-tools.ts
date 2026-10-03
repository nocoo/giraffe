import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { satisfies, valid } from "semver";
import { z } from "zod";
import { CRITICAL_PACKAGES } from "./config.ts";
import { githubRead } from "./github.ts";
import { latestPackage } from "./work-packages.ts";
import { assertAllowedDependencyUpdate, type WorkTask } from "./work-tasks.ts";
import type { WorkInspection, WorkWorkspace } from "./work-workspace.ts";

export async function verifyWorkRepository(repository: string) {
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
	tasks: WorkTask[],
	signal?: AbortSignal,
	criticalPackages: readonly string[] = CRITICAL_PACKAGES,
	evidence: { task: WorkTask; evidence: Record<string, unknown> }[] = [],
) {
	const committed: {
		task: string;
		head: string | null;
		outcome: "committed" | "reviewed_no_change" | "deferred";
		reason?: string;
	}[] = [];
	const metadata = new Map<string, Awaited<ReturnType<typeof latestPackage>>>();
	let originals: Record<string, string> | undefined;
	const unavailable = new Set(
		evidence.filter((item) => item.evidence.unavailable).map((item) => item.task.id),
	);
	const authorizedFor = (task: WorkTask, name: string) => {
		if (unavailable.has(task.id)) return false;
		if (task.kind !== "dependency") return false;
		const body = evidence.find((item) => item.task.id === task.id)?.evidence.body;
		return `${task.title}\n${typeof body === "string" ? body : ""}`
			.split(/[^a-zA-Z0-9@_./-]+/)
			.includes(name);
	};
	const authorized = (name: string) => tasks.some((task) => authorizedFor(task, name));
	const record = (
		task: string,
		head: string | null,
		outcome: "committed" | "reviewed_no_change" | "deferred",
		reason?: string,
	) => {
		const previous = committed.find((done) => done.task === task);
		const value = { task, head, outcome, ...(reason ? { reason } : {}) };
		if (previous) Object.assign(previous, value);
		else committed.push(value);
	};
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
			if (operation === "latest") {
				const name = z.string().parse(raw.name);
				if (!authorized(name)) throw new Error("Package is outside assigned dependency scope.");
				const result = await latestPackage(name, driver.packageRegistry);
				metadata.set(name, result);
				return result;
			}
			if (operation === "resolve") {
				const args = z
					.object({
						task: z.string(),
						outcome: z.enum(["reviewed_no_change", "deferred"]),
						reason: z.string().min(1).max(2000),
					})
					.parse(raw);
				const task = tasks.find((task) => task.id === args.task);
				if (!task) throw new Error("Unassigned task.");
				if (unavailable.has(task.id))
					throw new Error("Host evidence unavailable; disposition is fixed deferred.");
				if (task.kind === "dependency" && args.outcome === "reviewed_no_change")
					throw new Error("Dependency no-change requires satisfied evidence.");
				const current = await driver.inspect(workspace.repository);
				if (current.status !== workspace.status || current.diff !== workspace.diff)
					throw new Error("Resolve requires no uncommitted worker changes.");
				record(args.task, current.head, args.outcome, args.reason);
				return { ...args, head: current.head };
			}
			if (operation === "failure_log") {
				const task = tasks.find((task) => task.id === raw.task && task.kind === "ci");
				if (!task || unavailable.has(task.id))
					throw new Error("Only assigned evidenced failed runs can be read.");
				return driver.failureLog(workspace, task.number, signal);
			}
			if (operation === "satisfied") {
				const args = z.object({ task: z.string(), name: z.string() }).parse(raw);
				if (!tasks.some((task) => task.id === args.task && authorizedFor(task, args.name)))
					throw new Error("Only this assigned dependency evidence can be satisfied.");
				if (
					args.task !== tasks.find((task) => !committed.some((done) => done.task === task.id))?.id
				)
					throw new Error("Verification must cover the next assigned issue.");
				const metadata = await latestPackage(args.name, driver.packageRegistry);
				const manifest = JSON.parse(
					await readFile(resolve(workspace.path, "package.json"), "utf8"),
				);
				const declared = [
					"dependencies",
					"devDependencies",
					"optionalDependencies",
					"peerDependencies",
					"overrides",
				].some(
					(section) =>
						typeof manifest[section]?.[args.name] === "string" &&
						satisfies(metadata.version, manifest[section][args.name]),
				);
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
				record(args.task, current.head, "reviewed_no_change");
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
				if (dirtyPaths.some((dirty) => name === dirty || name.startsWith(`${dirty}/`)))
					throw new Error("Worker cannot overwrite pre-existing dirty files.");
				if (
					name === "AGENTS.md" ||
					name.startsWith(".husky/") ||
					(name.startsWith(".github/") && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(name))
				)
					throw new Error(
						"Worker cannot weaken tests or hooks; workflow repairs must be narrowly relevant.",
					);
				if (name === "package.json") {
					const before = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
					const after = JSON.parse(content) as Record<string, unknown>;
					if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts))
						throw new Error("Worker cannot change baseline check scripts.");
					const sections = [
						"dependencies",
						"devDependencies",
						"optionalDependencies",
						"peerDependencies",
						"overrides",
					];
					if (!originals) {
						const resolvedPackages = await driver.resolvedPackages(workspace, signal);
						originals = {};
						for (const section of sections)
							for (const [packageName, range] of Object.entries(before[section] ?? {})) {
								const resolved = resolvedPackages[packageName];
								if (resolved && valid(resolved) && satisfies(resolved, String(range)))
									originals[packageName] = resolved;
							}
					}
					for (const section of sections) {
						const old = (before[section] ?? {}) as Record<string, unknown>,
							next = (after[section] ?? {}) as Record<string, unknown>;
						for (const packageName of new Set([...Object.keys(old), ...Object.keys(next)])) {
							if (old[packageName] === next[packageName]) continue;
							const latest = metadata.get(packageName);
							if (
								!authorized(packageName) ||
								!latest ||
								!originals[packageName] ||
								next[packageName] !== latest.version
							)
								throw new Error(
									"Dependency mutation requires assigned scope, resolved original and latest stable mirror lookup.",
								);
							assertAllowedDependencyUpdate(
								packageName,
								originals[packageName],
								latest.version,
								criticalPackages,
							);
						}
					}
				}
				await writeFile(path, content);
				written.add(relative(await realpath(workspace.path), path));
				return { written: name };
			}
			if (operation === "check") {
				await driver.check(workspace, signal);
				return { passed: true };
			}
			if (operation === "repeat_test") {
				const args = z
					.object({ script: z.string(), count: z.number().int().min(2).max(5) })
					.parse(raw);
				if (!tasks.some((task) => task.kind === "ci" && !unavailable.has(task.id)))
					throw new Error("Repeated tests require an evidenced CI task.");
				return driver.repeatTest(workspace, args.script, args.count, signal);
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
						tasks: z.array(z.string()).min(1),
						files: z.array(z.string()).min(1),
						message: z
							.string()
							.max(50)
							.regex(/^(fix|feat|chore|refactor|test|docs): [a-z0-9].*$/),
					})
					.parse(raw);
				const assigned = tasks.filter((task) => !unavailable.has(task.id)).map((task) => task.id);
				const pending = assigned.filter((task) => !committed.some((done) => done.task === task));
				const remaining = pending.length ? pending : assigned;
				if (
					(pending.length > 0 && args.tasks[0] !== remaining[0]) ||
					new Set(args.tasks).size !== args.tasks.length ||
					args.tasks.some((task) => !remaining.includes(task)) ||
					args.files.some((path) => !written.has(path))
				)
					throw new Error(
						"Commit must contain only this worker's files and the next assigned issue.",
					);
				await driver.check(workspace, signal);
				const head = await driver.commit(workspace, args.files, args.message, signal);
				for (const task of args.tasks) record(task, head, "committed");
				written.clear();
				return { head };
			}
			throw new Error("Operation is not permitted for workers.");
		},
	};
}
