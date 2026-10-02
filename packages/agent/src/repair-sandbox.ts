import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { HostGitTransport, SandboxRequest, SandboxRunner } from "./repair-workspace.ts";

const exec = promisify(execFile);
export function dockerSandbox(image: string): SandboxRunner {
	if (!/^[a-zA-Z0-9./_-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/.test(image))
		throw new Error("Use an explicit trusted Docker image tag or digest.");
	return {
		verified: true,
		capabilities: { filesystem: true, network: true, resourceLimits: true },
		limitations: [
			"Install is offline: required package cache must be preseeded in the trusted image.",
			"Workspace disk usage is bounded by host capacity, not a container filesystem quota.",
		],
		async run(request: SandboxRequest) {
			const name = `giraffe-repair-${randomUUID()}`;
			const argv = request.argv.map((arg) =>
				arg.startsWith(`${request.workspace.path}/`)
					? `/work/${arg.slice(request.workspace.path.length + 1)}`
					: arg,
			);
			if (request.purpose === "install") argv.push("--offline");
			const args = [
				"run",
				"--rm",
				"--name",
				name,
				"--pull=never",
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--pids-limit=128",
				"--memory=2g",
				"--cpus=2",
				"--ulimit",
				"fsize=268435456:268435456",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=512m",
				"--mount",
				`type=bind,src=${request.workspace.path},dst=/work`,
				...(request.purpose === "commit"
					? []
					: ["--mount", `type=bind,src=${request.workspace.path}/.git,dst=/work/.git,readonly`]),
				"--workdir",
				"/work",
				"--env",
				"HOME=/tmp/home",
				"--env",
				"CI=1",
				"--env",
				"GIT_CONFIG_NOSYSTEM=1",
				"--env",
				"GIT_CONFIG_GLOBAL=/dev/null",
				"--env",
				"GIT_AUTHOR_NAME=Giraffe Agent",
				"--env",
				"GIT_AUTHOR_EMAIL=giraffe@users.noreply.github.com",
				"--env",
				"GIT_COMMITTER_NAME=Giraffe Agent",
				"--env",
				"GIT_COMMITTER_EMAIL=giraffe@users.noreply.github.com",
				...(request.stdin === undefined ? [] : ["-i"]),
				image,
				...argv,
			];
			try {
				const child = exec("docker", args, {
					timeout: request.timeoutMs,
					maxBuffer: 40000,
					...(request.signal ? { signal: request.signal } : {}),
					env: { PATH: process.env.PATH, HOME: process.env.HOME },
				});
				if (request.stdin !== undefined) child.child.stdin?.end(request.stdin);
				const result = await child;
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch {
				return {
					exitCode: 1,
					stdout: "",
					stderr:
						"Isolated execution failed; verify Docker, trusted cached image and dependency cache.",
				};
			} finally {
				await exec("docker", ["rm", "-f", name], {
					timeout: 10000,
					maxBuffer: 1024,
					env: { PATH: process.env.PATH, HOME: process.env.HOME },
				}).catch(() => {});
			}
		},
	};
}

export const hostGitTransport: HostGitTransport = async (request) => {
	if (
		request.command.command !== "git" ||
		!["clone", "ls-remote", "push"].includes(request.command.args[0] ?? "")
	)
		throw new Error("Unsupported host Git operation.");
	const args = [
		"-c",
		"credential.helper=",
		"-c",
		"credential.helper=!gh auth git-credential",
		...request.command.args,
	];
	try {
		const result = await exec("git", args, {
			cwd: request.cwd,
			timeout: request.timeoutMs,
			maxBuffer: request.maxOutputBytes,
			...(request.signal ? { signal: request.signal } : {}),
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				GIT_TERMINAL_PROMPT: "0",
				GH_PROMPT_DISABLED: "1",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_LFS_SKIP_SMUDGE: "1",
			},
		});
		return { exitCode: 0, stdout: result.stdout, stderr: "" };
	} catch {
		return { exitCode: 1, stdout: "", stderr: "Host Git transport failed." };
	}
};
