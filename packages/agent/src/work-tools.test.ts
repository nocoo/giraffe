import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubRead } from "./github.ts";
import { runLocal } from "./repair-local.ts";
import { latestPackage } from "./work-packages.ts";
import { reviewWork } from "./work-review.ts";
import { verifyWorkRepository, workerActions } from "./work-tools.ts";
import { WorkWorkspace } from "./work-workspace.ts";

vi.mock("./github.ts", async (original) => ({
	...(await original<typeof import("./github.ts")>()),
	githubRead: vi.fn(),
}));
vi.mock("./work-packages.ts", () => ({ latestPackage: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const task = (number: number) => ({
	id: `dependency:${number}`,
	kind: "dependency" as const,
	number,
	title: "Upgrade demo jsdom dep to 2.0.0",
	url: `https://github.com/owner/repo/issues/${number}`,
	updatedAt: "now",
});

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
	const worker = workerActions(driver as never, { path: directory, status: "" } as never, [
		task(1),
	]);
	const state = { round: 0, findings: [] as string[], head: null as string | null };
	try {
		await writeFile(join(directory, "code.ts"), "old");
		const approved = await reviewWork({
			load: async () => state,
			save: async (value) => Object.assign(state, value),
			fix: async (round) => {
				await worker.action("write", { path: "code.ts", content: `round ${round}` });
				await worker.action("commit", {
					tasks: ["dependency:1"],
					files: ["code.ts"],
					message: "fix: cause",
				});
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
		expect(worker.committed).toEqual([
			{ task: "dependency:1", head: approved, outcome: "committed" },
		]);
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
	const worker = workerActions(driver as never, { status: "" } as never, [task(1)]);
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
		[task(1)],
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
			JSON.stringify({ peerDependencies: { jsdom: "^30.1.1" } }),
		);
		await writeFile(join(directory, "bun.lock"), '"jsdom": ["jsdom@30.1.1", "", {}]');
		await expect(
			worker.action("satisfied", { task: "dependency:2", name: "jsdom" }),
		).rejects.toThrow(/assigned/);
		driver.inspect.mockResolvedValueOnce({
			head: "existing",
			status: " M package.json",
			diff: "change",
		});
		await expect(
			worker.action("satisfied", { task: "dependency:1", name: "jsdom" }),
		).rejects.toThrow(/pending/);
		await writeFile(join(directory, "bun.lock"), "old lock");
		await expect(
			worker.action("satisfied", { task: "dependency:1", name: "jsdom" }),
		).rejects.toThrow(/exact/);
		await writeFile(join(directory, "bun.lock"), '"jsdom": ["jsdom@30.1.1", "", {}]');
		expect(await worker.action("satisfied", { task: "dependency:1", name: "jsdom" })).toMatchObject(
			{
				alreadyCurrent: true,
				head: "existing",
			},
		);
		expect(worker.committed).toEqual([
			{ task: "dependency:1", head: "existing", outcome: "reviewed_no_change" },
		]);
		expect(driver.check).toHaveBeenCalledOnce();
		const npmWorker = workerActions(
			driver as never,
			{ path: directory, status: "", diff: "", manager: "npm" } as never,
			[task(2)],
		);
		await writeFile(
			join(directory, "package-lock.json"),
			JSON.stringify({ packages: { "node_modules/jsdom": { version: "30.1.1" } } }),
		);
		expect(
			await npmWorker.action("satisfied", { task: "dependency:2", name: "jsdom" }),
		).toMatchObject({
			alreadyCurrent: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("verifies owned nonfork nonarchived main once without task endpoint reads", async () => {
	const repo = {
		full_name: "owner/repo",
		owner: { login: "owner" },
		fork: false,
		archived: false,
		default_branch: "main",
	};
	for (const change of [
		{},
		{ fork: true },
		{ archived: true },
		{ default_branch: "dev" },
		{ full_name: "wrong" },
		{ owner: { login: "other" } },
	]) {
		vi.mocked(githubRead).mockReset();
		vi.mocked(githubRead)
			.mockResolvedValueOnce({ login: "owner" })
			.mockResolvedValueOnce({ ...repo, ...change });
		if (!Object.keys(change).length)
			await expect(verifyWorkRepository("owner/repo")).resolves.toBeUndefined();
		else await expect(verifyWorkRepository("owner/repo")).rejects.toThrow("scope");
		expect(githubRead).toHaveBeenCalledTimes(2);
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
	const worker = workerActions(
		driver as never,
		workspace as never,
		[task(1), task(2), task(3)],
		controller.signal,
	);
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
			worker.action("commit", { tasks: ["dependency:2"], files: ["code.ts"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await expect(
			worker.action("commit", { tasks: ["dependency:1"], files: ["unowned"], message: "fix: bug" }),
		).rejects.toThrow(/next/);
		await worker.action("check", {});
		await worker.action("install", {});
		expect(driver.install).toHaveBeenCalled();
		for (const tasks of [
			["dependency:1", "dependency:1"],
			["dependency:1", "dependency:99"],
		])
			await expect(
				worker.action("commit", { tasks, files: ["code.ts"], message: "fix: bug" }),
			).rejects.toThrow(/next/);
		await worker.action("commit", {
			tasks: ["dependency:1", "dependency:3"],
			files: ["code.ts"],
			message: "fix: bug",
		});
		expect(worker.committed).toEqual([
			{ task: "dependency:1", head: "head", outcome: "committed" },
			{ task: "dependency:3", head: "head", outcome: "committed" },
		]);
		expect(driver.check).toHaveBeenCalledTimes(2);
		await worker.action("write", { path: "code.ts", content: "fixed again" });
		await worker.action("commit", {
			tasks: ["dependency:2"],
			files: ["code.ts"],
			message: "fix: next",
		});
		expect(worker.committed.at(-1)?.task).toBe("dependency:2");
		await worker.action("write", { path: "code.ts", content: "review correction" });
		await worker.action("commit", {
			tasks: ["dependency:1"],
			files: ["code.ts"],
			message: "fix: review",
		});
		await worker.action("write", { path: "code.ts", content: "second task correction" });
		await worker.action("commit", {
			tasks: ["dependency:2"],
			files: ["code.ts"],
			message: "fix: second",
		});
		expect(worker.committed).toHaveLength(3);
		await expect(worker.action("push", {})).rejects.toThrow(/permitted/);
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ scripts: { test: "test" }, dependencies: {} }),
		);
		await expect(
			worker.action("write", { path: "package.json", content: JSON.stringify({ scripts: {} }) }),
		).rejects.toThrow(/scripts/);
		await expect(
			worker.action("write", {
				path: "package.json",
				content: JSON.stringify({ scripts: { test: "test" }, dependencies: { dep: "2" } }),
			}),
		).rejects.toThrow();
		await writeFile(
			join(directory, "biome.jsonc"),
			'{"$schema":"https://biomejs.dev/schemas/2.5.14/schema.json","linter":{"enabled":true}}',
		);
		await worker.action("write", {
			path: "biome.jsonc",
			content:
				'{"$schema":"https://biomejs.dev/schemas/2.5.15/schema.json","linter":{"enabled":true}}',
		});
		await worker.action("write", {
			path: "biome.jsonc",
			content:
				'{"$schema":"https://biomejs.dev/schemas/2.5.15/schema.json","linter":{"enabled":false}}',
		});
		await writeFile(join(directory, "large"), "x".repeat(256001));
		await expect(worker.action("read", { path: "large" })).rejects.toThrow(/budget/);
		controller.abort();
		await expect(worker.action("read", { path: "code.ts" })).rejects.toThrow(/cancelled/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("guards latest stable exact package scope and critical majors before writing a real JSONC Bun manifest", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-manifest-"));
	const manifest = {
		scripts: { test: "vitest" },
		dependencies: { vite: "1.0.0", vitest: "1.0.0", react: "18.0.0" },
		peerDependencies: { react: "18.0.0" },
		overrides: { vite: "1.0.0" },
	};
	await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
	await writeFile(
		join(directory, "bun.lock"),
		'{\n"packages": {\n"vite": ["vite@1.0.0", "", {}],\n"vitest": ["vitest@1.0.0", "", {}],\n"react": ["react@18.0.0", "", {}],\n},\n}\n',
	);
	const native = new WorkWorkspace({ run: runLocal });
	const workspace = { path: directory, manager: "bun", status: "", diff: "" };
	const driver = {
		packageRegistry: "https://mirrors.tencent.com/npm/",
		resolvedPackages: native.resolvedPackages.bind(native),
	};
	const assigned = [
		{ ...task(1), title: "Upgrade vitest from 1.0.0 to 1.1.0" },
		{ ...task(2), title: "Upgrade dependencies" },
	];
	const worker = workerActions(
		driver as never,
		workspace as never,
		assigned,
		undefined,
		["react"],
		[
			{
				task: assigned[1] as ReturnType<typeof task>,
				evidence: { body: "Upgrade react to current stable." },
			},
		],
	);
	try {
		expect(await native.resolvedPackages(workspace as never)).toEqual({
			vite: "1.0.0",
			vitest: "1.0.0",
			react: "18.0.0",
		});
		await expect(worker.action("latest", { name: "vite" })).rejects.toThrow("scope");
		vi.mocked(latestPackage).mockImplementation(async (name) => ({
			name,
			version: name === "react" ? "19.0.0" : "1.2.0",
			registry: driver.packageRegistry,
			verifiedAt: "now",
		}));
		const write = (content: unknown) =>
			worker.action("write", { path: "package.json", content: JSON.stringify(content) });
		await expect(
			write({ ...manifest, dependencies: { ...manifest.dependencies, vitest: "1.1.0" } }),
		).rejects.toThrow("lookup");
		await worker.action("latest", { name: "react" });
		await expect(
			write({ ...manifest, dependencies: { ...manifest.dependencies, react: "19.0.0" } }),
		).rejects.toThrow(/manual/);
		expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toEqual(manifest);
		await worker.action("latest", { name: "vitest" });
		await expect(
			write({ ...manifest, dependencies: { ...manifest.dependencies, vitest: "1.1.0" } }),
		).rejects.toThrow("latest");
		await expect(
			write({ ...manifest, dependencies: { ...manifest.dependencies, vite: "1.2.0" } }),
		).rejects.toThrow("scope");
		await write({ ...manifest, dependencies: { ...manifest.dependencies, vitest: "1.2.0" } });
		expect(
			JSON.parse(await readFile(join(directory, "package.json"), "utf8")).dependencies.vitest,
		).toBe("1.2.0");
		await expect(write({ ...manifest, dependencies: { vitest: "1.2.0" } })).rejects.toThrow(
			"scope",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("records PR no-change and deferred dependency outcomes, restricts logs to assigned CI and never fabricates a commit", async () => {
	const driver = {
		inspect: async () => ({ head: "base", status: "", diff: "" }),
		failureLog: vi.fn(async () => ({ content: "assertion failed", complete: true })),
		commit: vi.fn(),
	};
	const assigned = [
		{ ...task(1), id: "pr:1", kind: "pr" as const },
		task(1),
		{ ...task(1), id: "ci:1", kind: "ci" as const },
	];
	const worker = workerActions(driver as never, { status: "", diff: "" } as never, assigned);
	await worker.action("resolve", {
		task: "pr:1",
		outcome: "reviewed_no_change",
		reason: "Equivalent cleanup already present on main.",
	});
	await worker.action("resolve", {
		task: "dependency:1",
		outcome: "deferred",
		reason: "Critical major needs manual review.",
	});
	await expect(
		worker.action("resolve", {
			task: "dependency:1",
			outcome: "reviewed_no_change",
			reason: "pretend",
		}),
	).rejects.toThrow("satisfied");
	await expect(
		worker.action("resolve", { task: "pr:2", outcome: "deferred", reason: "unknown" }),
	).rejects.toThrow("Unassigned");
	await expect(worker.action("failure_log", { task: "pr:1" })).rejects.toThrow("assigned");
	expect(await worker.action("failure_log", { task: "ci:1" })).toMatchObject({
		content: "assertion failed",
	});
	expect(driver.failureLog).toHaveBeenCalledWith(expect.anything(), 1, undefined);
	expect(worker.committed.map((item) => item.task)).toEqual(["pr:1", "dependency:1"]);
	expect(driver.commit).not.toHaveBeenCalled();
});

it("never executes tasks whose host evidence is unavailable or satisfies another package's task", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-unavailable-"));
	const assigned = [
		{ ...task(1), title: "Upgrade vite to 2.0.0" },
		{ ...task(2), title: "Upgrade vitest to 2.0.0" },
		{ ...task(3), id: "pr:3", kind: "pr" as const },
	];
	const driver = {
		inspect: async () => ({ head: "base", status: "", diff: "" }),
		check: vi.fn(),
		commit: vi.fn(),
	};
	const worker = workerActions(
		driver as never,
		{ path: directory, status: "", diff: "" } as never,
		assigned,
		undefined,
		[],
		[
			{ task: assigned[0] as ReturnType<typeof task>, evidence: { unavailable: "missing issue" } },
			{
				task: assigned[2] as (typeof assigned)[number],
				evidence: { unavailable: "missing patch" },
			},
		],
	);
	try {
		await expect(worker.action("latest", { name: "vite" })).rejects.toThrow("scope");
		await expect(
			worker.action("satisfied", { task: "dependency:1", name: "vitest" }),
		).rejects.toThrow("this assigned");
		await expect(
			worker.action("resolve", { task: "pr:3", outcome: "reviewed_no_change", reason: "claim" }),
		).rejects.toThrow("fixed deferred");
		await writeFile(join(directory, "source.ts"), "old");
		await worker.action("write", { path: "source.ts", content: "fixed" });
		await expect(
			worker.action("commit", { tasks: ["pr:3"], files: ["source.ts"], message: "fix: claim" }),
		).rejects.toThrow("next");
		expect(driver.commit).not.toHaveBeenCalled();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("repeats only declared tests for evidenced CI tasks without exposing arbitrary shell", async () => {
	const driver = { repeatTest: vi.fn(async () => ({ count: 3, passed: true })) };
	const ci = { ...task(1), id: "ci:1", kind: "ci" as const };
	const worker = workerActions(driver as never, { status: "" } as never, [ci]);
	expect(
		await worker.action("repeat_test", { script: "test:unit:coverage", count: 3 }),
	).toMatchObject({ passed: true });
	await expect(worker.action("repeat_test", { script: "shell", count: 6 })).rejects.toThrow();
	await expect(
		workerActions(driver as never, { status: "" } as never, [task(1)]).action("repeat_test", {
			script: "test",
			count: 2,
		}),
	).rejects.toThrow("CI task");
});
