import { execFile } from "node:child_process";
import { promisify } from "node:util";
export type GithubRead = (path: string, signal?: AbortSignal) => Promise<unknown>;
const runFile = promisify(execFile);
export class WorkTransportError extends Error {}
export const githubRead: GithubRead = async (path, signal) => {
	if (!/^(?:user|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_%?=&.+/-]+)?)$/.test(path))
		throw new Error("Invalid GitHub read path.");
	try {
		const result = await runFile(
			"gh",
			["api", "--hostname", "github.com", "--method", "GET", path],
			{
				timeout: 30000,
				maxBuffer: 1024 * 1024,
				...(signal ? { signal } : {}),
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					GH_PROMPT_DISABLED: "1",
					GH_NO_UPDATE_NOTIFIER: "1",
				},
			},
		);
		return JSON.parse(result.stdout);
	} catch {
		throw new WorkTransportError("GitHub read failed; no mutation was attempted.");
	}
};
