import { expect, it } from "vitest";
import type { ActivitySnapshot } from "../../apps/web/src/lib/activity-types";
import type { RefreshRun } from "../../apps/web/src/lib/refresh-types";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const jwt = process.env.GIRAFFE_JWT ?? "";
function browser(path: string, method = "GET", body?: unknown) {
	return fetch(`${base}/api/${path}`, {
		method,
		headers: {
			origin: "https://giraffe.dev.hexly.ai",
			"content-type": "application/json",
			...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
it("runs real durable A then serial B, serves latest observations and reuses day caches", async () => {
	const existing = (await (await browser("accounts")).json()) as {
		accounts: { id: string; is_active: boolean }[];
	};
	const accountResponse = await browser("accounts", "POST", { token: `ghp_${"U".repeat(36)}` });
	expect(accountResponse.status).toBe(201);
	const account = (await accountResponse.json()) as { id: string };
	const tokenResponse = await browser("tokens", "POST", {
		account_id: account.id,
		label: "phase2 local acceptance",
		scopes: ["observations:read", "app:read", "app:write"],
		expires_in_days: 1,
	});
	expect(tokenResponse.status).toBe(201);
	const token = (await tokenResponse.json()) as { token: string };
	const machine = (path: string, method = "GET", body?: unknown) =>
		fetch(`${base}/api/v1/accounts/${account.id}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	async function run(params: unknown): Promise<RefreshRun> {
		const started = await machine("refresh-runs", "POST", params);
		expect(started.status).toBe(202);
		let item = (await started.json()) as RefreshRun;
		for (let attempt = 0; attempt < 60 && ["queued", "running"].includes(item.status); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			item = (await (await machine(`refresh-runs/${item.id}`)).json()) as RefreshRun;
		}
		expect(item.status).toBe("completed");
		const timings = item.timings;
		if (!timings?.a?.finishedAt || !item.finishedAt)
			throw new Error("Completed refresh must expose account step timings");
		expect(timings.queuedAt).toBe(item.createdAt);
		const accountStarted = Date.parse(timings.a.startedAt);
		expect(accountStarted).toBeGreaterThanOrEqual(Date.parse(timings.queuedAt));
		expect(accountStarted - Date.parse(timings.queuedAt)).toBeLessThanOrEqual(5_000);
		expect(timings.a.reused).toBe(item.aReused);
		expect(timings.a.attempts).toBe(1);
		let previousFinished = Date.parse(timings.a.finishedAt);
		expect(previousFinished).toBeGreaterThanOrEqual(accountStarted);
		expect(timings.repos.map((step) => step.repo)).toEqual(item.repos);
		for (const step of timings.repos) {
			if (!step.finishedAt) throw new Error("Completed repository must expose its finish time");
			const startedAt = Date.parse(step.startedAt);
			expect(startedAt).toBeGreaterThanOrEqual(previousFinished);
			expect(startedAt - previousFinished).toBeLessThanOrEqual(5_000);
			expect(step.attempts).toBe(1);
			previousFinished = Date.parse(step.finishedAt);
			expect(previousFinished).toBeGreaterThanOrEqual(startedAt);
		}
		expect(Date.parse(item.finishedAt)).toBeGreaterThanOrEqual(previousFinished);
		return item;
	}
	try {
		expect((await browser(`accounts/${account.id}/activate`, "POST")).status).toBe(200);
		for (const post of [browser, machine]) {
			const invalid = await post("refresh-runs", "POST", { requestKey: "client-retry" });
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
		}
		const discovery = await run({ dimensions: ["commits"] });
		expect(discovery.repos).toEqual([]);
		expect(discovery.requests).toBe(1);
		expect(discovery.requestBreakdown).toEqual({
			total: 1,
			graphql: 1,
			rest: 0,
			a: { graphql: 1, rest: 0 },
			b: { graphql: 0, rest: 0 },
		});
		const first = await run({
			dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
			repo: "phase2/demo",
		});
		expect(first.repos).toEqual(["phase2/demo"]);
		expect(first.completedRepos).toBe(1);
		expect(first.aReused).toBe(true);
		expect(first.requests).toBe(4);
		expect(first.requestBreakdown).toEqual({
			total: 4,
			graphql: 1,
			rest: 3,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 1, rest: 3 },
		});
		expect(first.partialReasons).toEqual([]);
		expect(await (await machine("stars")).json()).toEqual({ items: [] });
		for (const path of [
			"repos",
			"factory",
			"contributions",
			"repos/phase2/demo/details",
			"repos/phase2/demo/issues",
			"repos/phase2/demo/prs",
			"repos/phase2/demo/actions",
			"repos/phase2/demo/security",
			"factory/repos/phase2/demo/commits",
			"factory/repos/phase2/demo/dependencies",
		]) {
			const response = await machine(path);
			expect(response.status, path).toBe(200);
		}
		const dependencies = await machine("factory/repos/phase2/demo/dependencies");
		expect(await dependencies.json()).toMatchObject({
			data: {
				items: [],
				unavailable: true,
				fetched_at: null,
				coverage: { status: "unavailable", reason: "dependency_analysis_unavailable" },
			},
		});
		const browserDependencies = await browser("factory/repos/phase2/demo/dependencies?scope=all");
		expect(browserDependencies.status).toBe(200);
		expect(await browserDependencies.json()).toMatchObject({
			items: [],
			coverage: { status: "unavailable", reason: "dependency_analysis_unavailable" },
		});
		const contributions = await machine("contributions");
		const calendar = (await contributions.json()) as { data: { days: unknown[] } };
		expect(calendar.data.days.length).toBeGreaterThanOrEqual(365);
		expect(calendar.data.days.length).toBeLessThanOrEqual(367);
		const activityResponse = await machine("activity");
		expect(activityResponse.status).toBe(200);
		const activity = (await activityResponse.json()) as ActivitySnapshot;
		expect(activity.runId).toBe(first.id);
		expect(activity.repos[0]?.issues.opened).toEqual([
			expect.objectContaining({ title: "Fresh lifecycle observation" }),
		]);
		expect(activity.repos[0]?.commits).toMatchObject({ default: null, other: null, items: null });
		expect(activity.repos[0]?.coverage.commits?.status).toBe("unavailable");
		expect((await browser("activity")).status).toBe(200);
		const sources = (await (await machine("sources")).json()) as {
			sources: {
				resource: string;
				version: string;
				fetchedAt: string;
				contentVersion: string | null;
			}[];
		};
		expect(sources.sources.find((source) => source.resource === "account:activity")).toMatchObject({
			version: first.id,
			fetchedAt: activity.fetchedAt,
			contentVersion: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
		const defaultRun = await run({ dimensions: ["commits"] });
		expect(defaultRun.repos).toEqual([]);
		expect(defaultRun.requests).toBe(1);
		expect(
			(await machine("stars/phase2/demo", "PUT", { reason: "local refresh test" })).status,
		).toBe(200);
		const cached = await run({ dimensions: ["commits"] });
		expect(cached.repos).toEqual(["phase2/demo"]);
		expect(cached.requests).toBe(1);
		const forced = await run({ dimensions: ["commits"], repo: "phase2/demo", force: true });
		expect(forced.aReused).toBe(false);
		expect(forced.requests).toBe(2);
		expect(forced.requestBreakdown).toMatchObject({
			a: { graphql: 1, rest: 0 },
			b: { graphql: 1, rest: 0 },
		});
		const cacheWindow = {
			repo: "phase2/demo",
			since: "2026-01-05",
			until: "2026-01-05",
		};
		const graphqlOnly = await run({
			...cacheWindow,
			dimensions: ["commits", "issues", "prs", "releases"],
		});
		expect(graphqlOnly.aReused).toBe(true);
		expect(graphqlOnly.requestBreakdown).toEqual({
			total: 1,
			graphql: 1,
			rest: 0,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 1, rest: 0 },
		});
		const restOnly = await run(cacheWindow);
		expect(restOnly.aReused).toBe(true);
		expect(restOnly.requestBreakdown).toEqual({
			total: 3,
			graphql: 0,
			rest: 3,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 0, rest: 3 },
		});
		const allCached = await run(cacheWindow);
		expect(allCached.aReused).toBe(true);
		expect(allCached.requests).toBe(0);
		expect(allCached.requestBreakdown).toEqual({
			total: 0,
			graphql: 0,
			rest: 0,
			a: { graphql: 0, rest: 0 },
			b: { graphql: 0, rest: 0 },
		});
		expect(allCached.partialReasons).toEqual([]);
		const cachedSecurity = await machine("repos/phase2/demo/security");
		expect(await cachedSecurity.json()).toMatchObject({
			data: {
				unavailable: true,
				truncated: false,
				dependabot_open: 1,
				code_scanning_open: null,
				features: {
					dependabot: { status: "available" },
					code_scanning: { status: "unavailable", reason_code: "not_found" },
				},
			},
		});
		expect(await (await machine("factory")).json()).toMatchObject({
			data: {
				repos: [expect.objectContaining({ metrics: expect.objectContaining({ alerts: 1 }) })],
			},
		});
		expect((await machine("stars/phase2/demo", "DELETE")).status).toBe(200);
		for (const cancel of [
			() => machine(`refresh-runs/${first.id}/cancel`, "POST"),
			() => browser(`refresh-runs/${first.id}/cancel`, "POST"),
		]) {
			const response = await cancel();
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(first);
		}
		expect((await machine("refresh-runs/missing/cancel", "POST")).status).toBe(404);
		expect((await browser("refresh-runs/missing/cancel", "POST")).status).toBe(404);
		const pending = await machine("refresh-runs", "POST", {
			repo: "phase2/demo",
			dimensions: ["commits"],
			force: true,
		});
		expect(pending.status).toBe(202);
		let cancelled = (await pending.json()) as RefreshRun;
		const cancellation = await browser(`refresh-runs/${cancelled.id}/cancel`, "POST");
		expect([200, 202]).toContain(cancellation.status);
		cancelled = (await cancellation.json()) as RefreshRun;
		for (
			let attempt = 0;
			attempt < 40 && ["queued", "running"].includes(cancelled.status);
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			cancelled = (await (await machine(`refresh-runs/${cancelled.id}`)).json()) as RefreshRun;
		}
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.cancelRequested).toBe(true);
		expect(cancelled.finishedAt).not.toBeNull();
		const repeated = await machine(`refresh-runs/${cancelled.id}/cancel`, "POST");
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toEqual(cancelled);
		expect((await machine(`refresh-runs/${cancelled.id}/cancel`)).status).toBe(405);
		expect((await machine("repos/phase2/demo/details")).status).toBe(200);
		const list = (await (await machine("refresh-runs")).json()) as { items: RefreshRun[] };
		expect(list.items).toHaveLength(9);
		expect((await machine(`refresh-runs/${first.id}`, "DELETE")).status).toBe(405);
	} finally {
		await browser(`accounts/${account.id}`, "DELETE");
		const previous = existing.accounts.find((item) => item.is_active);
		if (previous) await browser(`accounts/${previous.id}/activate`, "POST");
	}
}, 60_000);
