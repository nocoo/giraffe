import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { LocalCleanupError, runLocal } from "./repair-local.ts";

vi.setConfig({ testTimeout: 20000 });
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function temporary() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "giraffe-native-")));
	directories.push(directory);
	return directory;
}
it("runs the actual local executable in the repair directory, with HOME and no automatic model secrets", async () => {
	const cwd = await temporary();
	vi.stubEnv("GIRAFFE_API_KEY", "do-not-inherit");
	vi.stubEnv("OPENAI_API_KEY", "do-not-inherit");
	const result = await runLocal({
		command: process.execPath,
		args: [
			"-e",
			"console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,key:process.env.GIRAFFE_API_KEY,openai:process.env.OPENAI_API_KEY,path:process.env.PATH}))",
		],
		cwd,
		timeoutMs: 5000,
		maxOutputBytes: 4096,
	});
	expect(result.exitCode).toBe(0);
	const data = JSON.parse(result.stdout);
	expect(data.cwd).toBe(cwd);
	expect(data.home).toBe(process.env.HOME);
	expect(data.key).toBeUndefined();
	expect(data.openai).toBeUndefined();
	expect(data.path.split(delimiter)).not.toContain(join(cwd, "node_modules", ".bin"));
});
it("passes arguments without shell interpolation, allows normal filesystem access, and reports command failures", async () => {
	const cwd = await temporary();
	const sibling = join(cwd, "sibling");
	await mkdir(sibling);
	const result = await runLocal({
		command: process.execPath,
		args: [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1],process.argv[2]);console.error('check failed');process.exitCode=7",
			join(sibling, "marker"),
			"$(not-a-shell-command)",
		],
		cwd,
		timeoutMs: 5000,
		maxOutputBytes: 4096,
	});
	expect(result.exitCode).toBe(7);
	expect(result.stderr).toContain("check failed");
	expect(await readFile(join(sibling, "marker"), "utf8")).toBe("$(not-a-shell-command)");
});
it("bounds hung commands and output and accepts caller cancellation", async () => {
	const cwd = await temporary();
	const request = {
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd,
		timeoutMs: 50,
		maxOutputBytes: 1024,
	};
	expect((await runLocal(request)).exitCode).not.toBe(0);
	expect((await runLocal({ ...request, signal: AbortSignal.abort() })).exitCode).not.toBe(0);
	expect(
		(
			await runLocal({
				...request,
				timeoutMs: 5000,
				args: ["-e", "console.log('x'.repeat(20000))"],
			})
		).exitCode,
	).not.toBe(0);
	expect((await runLocal({ ...request, command: join(cwd, "missing") })).exitCode).not.toBe(0);
});
it("falls back to an absolute system PATH and reports signal termination", async () => {
	const cwd = await temporary();
	vi.stubEnv("PATH", undefined);
	const result = await runLocal({
		command: process.execPath,
		args: ["-e", "process.kill(process.pid,'SIGTERM')"],
		cwd,
		timeoutMs: 5000,
		maxOutputBytes: 4096,
	});
	expect(result.exitCode).not.toBe(0);
});
it("does not let dependency executables replace host Git or gh", async () => {
	const cwd = await temporary();
	const projectBin = join(cwd, "node_modules", ".bin");
	const trustedBin = join(cwd, "host-bin");
	await mkdir(projectBin, { recursive: true });
	await mkdir(trustedBin);
	await writeFile(join(trustedBin, "gh"), "#!/bin/sh\nprintf trusted-gh\n", { mode: 0o755 });
	vi.stubEnv("PATH", `${trustedBin}${delimiter}${process.env.PATH}`);
	for (const command of ["git", "gh"])
		await writeFile(join(projectBin, command), "#!/bin/sh\ntouch intercepted\n", { mode: 0o755 });
	for (const command of ["git", "gh"]) {
		const result = await runLocal({
			command,
			args: ["--version"],
			cwd,
			timeoutMs: 5000,
			maxOutputBytes: 4096,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(command === "git" ? "git version" : "trusted-gh");
	}
	await expect(readFile(join(cwd, "intercepted"))).rejects.toThrow();
});
it.each(["timeout", "abort", "output"] as const)(
	"terminates descendant processes after %s before returning",
	async (mode) => {
		const cwd = await temporary();
		const marker = join(cwd, "late-write");
		const controller = new AbortController();
		const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),900)`;
		const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});${mode === "output" ? "console.log('x'.repeat(20000));" : ""}setInterval(()=>{},1000)`;
		const request = runLocal({
			command: process.execPath,
			args: ["-e", script],
			cwd,
			timeoutMs: mode === "timeout" ? 250 : 5000,
			maxOutputBytes: 1024,
			signal: controller.signal,
		});
		if (mode === "abort") {
			await delay(250);
			controller.abort();
		}
		expect((await request).exitCode).not.toBe(0);
		await delay(1100);
		await expect(readFile(marker)).rejects.toThrow();
	},
	10000,
);
it("signals its owned process group only once and never retries a reaped pid", async () => {
	const cwd = await temporary();
	const kill = process.kill.bind(process);
	const groups = new Set<number>();
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid < 0) {
			expect(groups.has(pid)).toBe(false);
			groups.add(pid);
		}
		return kill(pid, signal);
	});
	const result = await runLocal({
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		cwd,
		timeoutMs: 150,
		maxOutputBytes: 4096,
	});
	expect(result.exitCode).not.toBe(0);
	expect(groups.size).toBe(1);
});
it("reports a process cleanup permission error without throwing from event listeners", async () => {
	const cwd = await temporary();
	const kill = process.kill.bind(process);
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		try {
			kill(pid, signal);
		} catch {}
		throw Object.assign(new Error("fixture permission failure"), { code: "EPERM" });
	});
	await expect(
		runLocal({
			command: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)"],
			cwd,
			timeoutMs: 150,
			maxOutputBytes: 4096,
		}),
	).rejects.toBeInstanceOf(LocalCleanupError);
});
