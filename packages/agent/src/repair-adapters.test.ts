import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ execute: vi.fn(), input: vi.fn() }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	const fake = Object.assign(() => {}, {
		[Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => {
			const promise = mocked.execute(...args) as Promise<{ stdout: string; stderr: string }> & {
				child: { stdin: { end: typeof mocked.input } };
			};
			promise.child = { stdin: { end: mocked.input } };
			return promise;
		},
	});
	return { ...actual, execFile: fake };
});

import { dockerSandbox, hostGitTransport } from "./repair-sandbox.ts";
import { githubRead } from "./repair-source.ts";

afterEach(() => {
	vi.clearAllMocks();
});
const workspace = {
	path: "/isolated/repair",
	id: "deps-1",
	repository: "owner/repo",
	branch: "giraffe/deps-1",
	baseSha: "a".repeat(40),
};
it("isolates container filesystem, network and resources without model credentials", async () => {
	mocked.execute.mockResolvedValue({ stdout: "passed", stderr: "" });
	const runner = dockerSandbox("giraffe-tools:1");
	const result = await runner.run({
		workspace,
		argv: ["npm", "install", "--ignore-scripts"],
		purpose: "install",
		timeoutMs: 1000,
		signal: new AbortController().signal,
	});
	expect(result.exitCode).toBe(0);
	const call = mocked.execute.mock.calls[0];
	expect(call?.[0]).toBe("docker");
	expect(call?.[1]).toContain("--network=none");
	expect(call?.[1]).toContain("--offline");
	expect(call?.[1]).toContain("--pids-limit=128");
	expect(Object.keys(call?.[2].env)).toEqual(["PATH", "HOME"]);
	await runner.run({
		workspace,
		argv: ["/isolated/repair/.husky/pre-push", "origin"],
		purpose: "prepush",
		stdin: "refs heads",
		timeoutMs: 1000,
	});
	expect(mocked.execute.mock.calls[2]?.[1]).toContain("/work/.husky/pre-push");
	expect(mocked.input).toHaveBeenCalledWith("refs heads");
	expect(() => dockerSandbox("latest")).toThrow();
	await runner.run({
		workspace,
		argv: ["git", "commit", "-m", "fix"],
		purpose: "commit",
		timeoutMs: 1000,
	});
	expect(
		mocked.execute.mock.calls.some((call) => call[0] === "docker" && call[1][0] === "rm"),
	).toBe(true);
	mocked.execute.mockRejectedValueOnce(new Error("secret token failure"));
	expect(
		(await runner.run({ workspace, argv: ["npm", "test"], purpose: "check", timeoutMs: 1 })).stderr,
	).not.toContain("secret token");
});
it("uses only fixed host Git operations and read-only gh requests with scrubbed model env", async () => {
	mocked.execute.mockResolvedValue({ stdout: "ok", stderr: "sensitive" });
	const base = {
		operation: "remoteHead" as const,
		repository: "owner/repo",
		cwd: "/fixture",
		timeoutMs: 1000,
		maxOutputBytes: 1000,
	};
	expect(
		await hostGitTransport({
			...base,
			command: { command: "git", args: ["ls-remote", "https://github.com/owner/repo.git"] },
		}),
	).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
	await hostGitTransport({
		...base,
		signal: new AbortController().signal,
		command: { command: "git", args: ["ls-remote", "https://github.com/owner/repo.git"] },
	});
	await expect(
		hostGitTransport({ ...base, command: { command: "sh", args: ["-c", "bad"] } }),
	).rejects.toThrow();
	mocked.execute.mockRejectedValueOnce(new Error("private"));
	expect(
		(await hostGitTransport({ ...base, command: { command: "git", args: ["push"] } })).exitCode,
	).toBe(1);
	mocked.execute.mockResolvedValueOnce({ stdout: '{"login":"owner"}', stderr: "" });
	expect(await githubRead("user", new AbortController().signal)).toEqual({ login: "owner" });
	expect(mocked.execute.mock.lastCall?.[1]).toContain("GET");
	mocked.execute.mockRejectedValueOnce(new Error("private"));
	await expect(githubRead("repos/owner/repo")).rejects.toThrow("GitHub read failed");
});
