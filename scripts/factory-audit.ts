/** Local investigator: gh owns credentials; raw responses stay in the ignored cache. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactorySnapshot, FactoryStreamData } from "../src/lib/factory-types";
import type { Env } from "../src/server/env";
import { newFactory, stepFactory } from "../src/server/lib/factory-collect";
import { createGithubClient } from "../src/server/lib/github-client";

const dir = process.argv[2] ?? ".factory-cache/audit";
await mkdir(join(dir, "http"), { recursive: true, mode: 0o700 });
const snapshotPath = join(dir, "snapshot.json");
let state: FactorySnapshot;
try {
	state = JSON.parse(await readFile(snapshotPath, "utf8"));
} catch {
	const login = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const owner = (await new Response(login.stdout).text()).trim();
	if ((await login.exited) || !/^[A-Za-z0-9-]+$/.test(owner))
		throw new Error("gh GitHub account unavailable");
	state = newFactory("local_audit_account_1", owner, new Date().toISOString());
}
const save = async () => writeFile(snapshotPath, JSON.stringify(state), { mode: 0o600 });
const store = {
	read: async (key: string): Promise<FactoryStreamData | null> => {
		try {
			return JSON.parse(await readFile(join(dir, `${encodeURIComponent(key)}.json`), "utf8"));
		} catch {
			return null;
		}
	},
	write: async (key: string, data: FactoryStreamData) => {
		await writeFile(join(dir, `${encodeURIComponent(key)}.json`), JSON.stringify(data), {
			mode: 0o600,
		});
	},
};
const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input));
	const path = `${url.pathname}${url.search}`;
	const body = typeof init?.body === "string" ? init.body : "";
	const hash = createHash("sha256")
		.update(path + body)
		.digest("hex");
	const file = join(dir, "http", `${hash}.json`);
	type Cached = {
		status: number;
		headers: Record<string, string>;
		body: string;
		fetchedAt: string;
		path: string;
	};
	let cached: Cached | null = null;
	try {
		cached = JSON.parse(await readFile(file, "utf8"));
	} catch {
		/* not fetched */
	}
	if (!cached) {
		const args = ["gh", "api", "--include", path, "--method", init?.method ?? "GET"];
		if (body) args.push("--input", "-");
		const proc = Bun.spawn(args, {
			stdin: body ? new Blob([body]) : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;
		const boundary = output.search(/\r?\n\r?\n/);
		const header = output.slice(0, boundary);
		const status = Number(header.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
		if (!status || boundary < 0) throw new Error("GitHub CLI transport failed; resume later");
		const responseHeaders: Record<string, string> = {};
		for (const line of header.split(/\r?\n/).slice(1)) {
			const index = line.indexOf(":");
			if (index > 0)
				responseHeaders[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
		}
		cached = {
			status,
			headers: responseHeaders,
			body: output.slice(boundary).replace(/^\r?\n\r?\n/, ""),
			fetchedAt: new Date().toISOString(),
			path,
		};
		if (status >= 200 && status < 300)
			await writeFile(file, JSON.stringify(cached), { mode: 0o600 });
	}
	return new Response(cached.body, { status: cached.status, headers: cached.headers });
};
try {
	while (state.status !== "complete") {
		const gh = createGithubClient({ ENVIRONMENT: "production" } as Env, transport);
		for (let i = 0; i < 6 && (state as FactorySnapshot).status !== "complete"; i++) {
			const checkpoint = structuredClone(state);
			try {
				await stepFactory(state, gh, "credential-owned-by-gh-cli", store, new Date().toISOString());
				await save();
			} catch (error) {
				checkpoint.requests = state.requests;
				state = checkpoint;
				throw error;
			}
		}
		console.log(
			`${state.inventory.scanned}/${state.inventory.total} inventory · ${state.cursor.repo}/${state.repos.length} repos · ${state.requests} requests`,
		);
	}
	console.log(`Complete: ${snapshotPath}. Private data; not a public fixture.`);
} catch (error) {
	await save();
	console.error(error instanceof Error ? error.message : "Audit paused");
	process.exitCode = 1;
}
