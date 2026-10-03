import { spawn } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";

export type LocalCommand = {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
};
export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type LocalRunner = (request: LocalCommand) => Promise<CommandResult>;
export class LocalCleanupError extends Error {
	constructor() {
		super("Local process cleanup failed; operator intervention required.");
	}
}
export const runLocal: LocalRunner = async (request) => {
	const env = Object.fromEntries(
		[
			"HOME",
			"USER",
			"LOGNAME",
			"SHELL",
			"TMPDIR",
			"TMP",
			"TEMP",
			"SystemRoot",
			"LANG",
			"LC_ALL",
			"HTTPS_PROXY",
			"HTTP_PROXY",
			"NO_PROXY",
			"https_proxy",
			"http_proxy",
			"no_proxy",
		].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
	);
	if (request.signal?.aborted)
		return { exitCode: 1, stdout: "", stderr: "Local command cancelled." };
	return new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...env,
				PATH: (process.env.PATH ?? "/usr/bin:/bin")
					.split(delimiter)
					.filter((path) => isAbsolute(path) && !path.includes("node_modules/.bin"))
					.join(delimiter),
				...request.env,
			},
		});
		const stdout: Buffer[] = [],
			stderr: Buffer[] = [];
		let bytes = 0,
			stopped = false,
			signalled = false;
		const killGroup = () => {
			if (!child.pid || signalled) return;
			signalled = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					stopped = true;
					clearTimeout(timer);
					request.signal?.removeEventListener("abort", stop);
					reject(new LocalCleanupError());
				}
			}
		};
		const stop = () => {
			stopped = true;
			killGroup();
		};
		const timer = setTimeout(stop, request.timeoutMs);
		request.signal?.addEventListener("abort", stop, { once: true });
		const capture = (output: Buffer[]) => (chunk: Buffer) => {
			if (stopped) return;
			output.push(chunk.subarray(0, Math.max(0, request.maxOutputBytes - bytes)));
			bytes += chunk.length;
			if (bytes > request.maxOutputBytes) stop();
		};
		child.stdout.on("data", capture(stdout));
		child.stderr.on("data", capture(stderr));
		child.on("error", stop);
		child.on("exit", killGroup);
		child.on("close", (code) => {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", stop);
			resolve({
				exitCode: stopped ? 1 : (code ?? 1),
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
};
