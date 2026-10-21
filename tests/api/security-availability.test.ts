import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const root = resolve(import.meta.dirname, "../..");
const origin = "https://giraffe.dev.hexly.ai";

function sql(command: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		new URL(base).hostname !== "127.0.0.1" ||
		persist !== join(root, ".wrangler/e2e") ||
		config !== join(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 context required");
	const result = execFileSync(
		join(root, "node_modules/.bin/wrangler"),
		[
			"d1",
			"execute",
			"giraffe-db",
			"--local",
			`--persist-to=${persist}`,
			`--config=${config}`,
			"--json",
			"--command",
			command,
		],
		{ cwd: root, encoding: "utf8" },
	);
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(entry) => entry.results,
	);
}

const browser = (path: string, method = "GET", body?: unknown) =>
	fetch(`${base}/api/${path}`, {
		method,
		headers: {
			origin,
			"content-type": "application/json",
			...(process.env.GIRAFFE_JWT ? { "Cf-Access-Jwt-Assertion": process.env.GIRAFFE_JWT } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

it.each([
	["E", "alerts_disabled"],
	["F", "permission_denied"],
	["G", "not_found"],
	["H", "unknown"],
])(
	"publishes safe %s security diagnostics and separates unavailable run counts (%s)",
	async (letter, reasonCode) => {
		expect(sql("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
		const created = await browser("accounts", "POST", { token: `ghp_${letter.repeat(36)}` });
		expect(created.status).toBe(201);
		const account = (await created.json()) as { id: string; login: string };
		expect((await browser(`accounts/${account.id}/activate`, "POST")).status).toBe(200);
		const minted = await browser("tokens", "POST", {
			account_id: account.id,
			label: "security availability L2",
			scopes: ["observations:read", "app:read", "app:write"],
			expires_in_days: 1,
		});
		expect(minted.status).toBe(201);
		const token = (await minted.json()) as { token: string };
		const machine = (path: string, method = "GET", body?: unknown) =>
			fetch(`${base}/api/v1/accounts/${account.id}/${path}`, {
				method,
				headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		type Run = {
			id: string;
			status: string;
			counts: { unavailable: number; failed: number };
			steps: { status: string; reasonCode?: string }[];
		};
		const runs = async () =>
			((await (await machine("refresh-runs")).json()) as { items: Run[] }).items;
		const start = async (mode: string) => {
			const response = await machine("refresh-runs", "POST", {
				requestKey: crypto.randomUUID(),
				mode,
				scope: "selected",
				...(mode === "refresh" ? { repos: [`${account.login}/hello-world`] } : {}),
			});
			expect(response.status).toBe(202);
			const run = (await response.json()) as { id: string };
			await expect
				.poll(async () => (await runs()).find((item) => item.id === run.id)?.status, {
					timeout: 30000,
					interval: 200,
				})
				.toBe("completed");
			return (await runs()).find((item) => item.id === run.id) as Run;
		};
		try {
			await start("catalog");
			expect(sql("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
			sql(
				`UPDATE factory_state SET next_at='2000-01-01T00:00:00.000Z' WHERE account_id='${account.id}'; UPDATE factory_runs SET created_at='2000-01-01T00:00:00.000Z' WHERE account_id='${account.id}'`,
			);
			const run = await start("refresh");
			expect(run.counts.unavailable).toBeGreaterThan(0);
			expect(run.counts.failed).toBe(0);
			expect(run.steps.filter((step) => step.status === "unavailable").length).toBeGreaterThan(0);
			const factory = await browser("factory?scope=all");
			expect(factory.status).toBe(200);
			expect(await factory.json()).toMatchObject({
				status: "complete",
				runId: run.id,
				repos: [{ coverage: { alerts: { status: "unavailable", reason_code: reasonCode } } }],
			});
			const readsBefore = Number(await (await fetch("http://127.0.0.1:17046/_count")).text());
			const security = await machine(`repos/${account.login}/hello-world/security`);
			expect(security.status).toBe(200);
			const snapshot = await security.json();
			expect(snapshot).toMatchObject({
				unavailable: true,
				truncated: false,
				data: { reason_code: reasonCode, dependabot_open: 0, code_scanning_open: 0 },
			});
			expect(JSON.stringify(snapshot)).not.toContain("private upstream diagnostics");
			expect(await (await machine("sources")).json()).toMatchObject({
				sources: expect.arrayContaining([
					expect.objectContaining({
						resource: `factory:${account.login}/hello-world:alerts`,
						unavailable: true,
						coverage: expect.objectContaining({ reason_code: reasonCode }),
					}),
				]),
			});
			expect(Number(await (await fetch("http://127.0.0.1:17046/_count")).text())).toBe(readsBefore);
		} finally {
			expect((await browser(`accounts/${account.id}`, "DELETE")).status).toBe(204);
		}
	},
);
