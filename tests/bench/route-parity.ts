import assert from "node:assert/strict";
import { makeRun } from "../../apps/web/src/lib/factory-run";
import { FACTORY_STREAMS } from "../../apps/web/src/lib/factory-types";
import type { Env } from "../../apps/web/src/server/env";
import { createApp } from "../../apps/web/src/server/index";
import { createApiToken } from "../../apps/web/src/server/lib/api-tokens";
import { savedContentMeta } from "../../apps/web/src/server/lib/content-version";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { profileDb } from "../fixtures/profile-db";
import { revisionFixture } from "../fixtures/revision";
import { populateSourceStreams, sourcesFixture } from "../fixtures/sources";

const baselineSha = process.env.GIRAFFE_PERF_BASELINE ?? "6f87d669eb67d92d1ad8a404c8a1fa0e4ffcf3b3";
const revision = revisionFixture(baselineSha);
const OriginalDate = globalThis.Date;
const fixedNow = Date.parse("2026-10-22T08:00:00.000Z");
globalThis.Date = class extends OriginalDate {
	constructor(value: string | number = fixedNow) {
		super(value);
	}
	static now() {
		return fixedNow;
	}
} as DateConstructor;
const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("route parity forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

try {
	const baseline = await revision.load<typeof import("../../apps/web/src/server/index")>(
		"apps/web/src/server/index.ts",
	);
	const fixture = await sourcesFixture();
	await populateSourceStreams(fixture);
	for (const repo of fixture.snapshot.repos) {
		for (const stream of FACTORY_STREAMS.filter((name) => name !== "commits")) {
			const resource = {
				runId: repo.observation?.version,
				next: null,
				ranges: [fixture.snapshot.window],
				coverage: repo.coverage[stream],
				items: [],
			};
			await fixture.raw
				.prepare(
					"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES(?,?,?,?,?)",
				)
				.bind(
					resource.runId,
					repo.name,
					stream,
					JSON.stringify(resource),
					await savedContentMeta(
						`factory:${repo.name}:${stream}`,
						resource,
						fixture.snapshot.window,
					),
				)
				.run();
		}
	}
	await fixture.save("repo:fixture/project-001:traffic", { views: [], clones: [] });
	await fixture.save("repo:fixture/project-001:security", { features: {}, alerts: [] });
	await fixture.raw
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,'repo:fixture/orphan:actions#2','invalid-json','invalid-time')",
		)
		.bind(fixture.account)
		.run();
	for (const [kind, key] of [
		["repos", "repos"],
		["repo:fixture/project-001:actions", "runs"],
	] as const) {
		const row = await fixture.raw
			.prepare("SELECT payload,content_meta FROM snapshots WHERE account_id=? AND kind=?")
			.bind(fixture.account, kind)
			.first<{ payload: string; content_meta: string }>();
		assert.ok(row);
		const data = JSON.parse(row.payload);
		const midpoint = Math.floor(data[key].length / 2);
		await fixture.raw
			.prepare("UPDATE snapshots SET payload=? WHERE account_id=? AND kind=?")
			.bind(JSON.stringify({ ...data, [key]: data[key].slice(0, midpoint) }), fixture.account, kind)
			.run();
		await fixture.raw
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
			)
			.bind(
				fixture.account,
				`${kind}#2`,
				JSON.stringify({ ...data, [key]: data[key].slice(midpoint) }),
				fixture.latest,
				row.content_meta,
			)
			.run();
	}
	await fixture.raw
		.prepare("UPDATE accounts SET is_active=1 WHERE id=?")
		.bind(fixture.account)
		.run();
	const runRows = await fixture.raw.prepare("SELECT id FROM factory_runs").all<{ id: string }>();
	for (const row of runRows.results) {
		const run = makeRun(row.id, fixture.account, "fixture", row.id, "refresh", [], fixture.old);
		run.status = "completed";
		run.finishedAt = fixture.latest;
		await fixture.raw
			.prepare("UPDATE factory_runs SET payload=?,created_at=?,updated_at=? WHERE id=?")
			.bind(JSON.stringify(run), run.startedAt, run.finishedAt, row.id)
			.run();
	}
	const publicationKind = `factory:v:${fixture.snapshot.runId}`;
	const publication = {
		...fixture.snapshot,
		contribution: {
			days: [{ date: "2026-10-19", count: 4 }],
			fetchedAt: fixture.latest,
		},
	};
	await fixture.raw
		.prepare("UPDATE snapshots SET payload=?,content_meta=? WHERE account_id=? AND kind=?")
		.bind(
			JSON.stringify(publication),
			await savedContentMeta(publicationKind, publication),
			fixture.account,
			publicationKind,
		)
		.run();
	const token = await createApiToken(createDb(fixture.raw), {
		accountId: fixture.account,
		label: "local-parity",
		scopes: ["observations:read", "app:read"],
		expiresInDays: 1,
		creator: "fixture@local.test",
	});
	const browser = "/api";
	const machine = `/api/v1/accounts/${fixture.account}`;
	const routes = [
		...[browser, machine].flatMap((prefix) => [
			...["repos", "issues", "prs", "ci", "factory"].flatMap((resource) =>
				["all", "starred"].map((scope) => `${prefix}/${resource}?scope=${scope}`),
			),
			...["", "/issues", "/prs", "/actions", "/releases", "/traffic", "/security"].map(
				(tab) => `${prefix}/repos/fixture/project-001${tab}`,
			),
			...FACTORY_STREAMS.map((stream) => `${prefix}/factory/repos/fixture/project-001/${stream}`),
			`${prefix}/repos/fixture/removed-history/issues`,
			`${prefix}/repos?scope=invalid`,
		]),
		`${browser}/refresh/settings`,
		`${browser}/factory/runs`,
		`${machine}/settings`,
		`${machine}/refresh-runs`,
		`${machine}/contributions`,
		`${machine}/contributions?since=2026-10-19&until=2026-10-19`,
		`${machine}/contributions?since=invalid`,
		...[
			"",
			"?since=2026-10-19T00:00:00.000Z",
			"?since=2026-10-21T00:00:00.000Z",
			"?repository=FIXTURE/PROJECT-001",
			"?repository=fixture/missing",
		].map((query) => `${machine}/sources${query}`),
	];
	async function request(app: ReturnType<typeof createApp>, route: string, tag?: string) {
		const profile = profileDb(fixture.raw);
		const startedAt = performance.now();
		const response = await app.request(
			`http://localhost${route}`,
			{
				headers: {
					Authorization: `Bearer ${token.token}`,
					...(tag ? { "If-None-Match": tag } : {}),
				},
			},
			{ DB: profile.raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
		);
		const body = await response.text();
		return {
			status: response.status,
			body,
			etag: response.headers.get("etag"),
			privateHeaders: JSON.stringify(
				["cache-control", "vary", "referrer-policy", "content-type"].map((name) => [
					name,
					response.headers.get(name),
				]),
			),
			timing: response.headers.get("server-timing"),
			trips: profile.trips.length,
			queries: profile.queries.length,
			payloadBytes: profile.queries.reduce((total, query) => total + query.payloadBytes, 0),
			ms: performance.now() - startedAt,
		};
	}
	const beforeApp = baseline.createApp();
	const afterApp = createApp();
	for (const metadata of ["stored", "mismatched", "legacy"]) {
		if (metadata === "mismatched")
			await fixture.raw
				.prepare("UPDATE snapshots SET content_meta=? WHERE kind LIKE '%#2'")
				.bind(
					JSON.stringify({ hash: "different-page-hash", fullVersion: "different-page-version" }),
				)
				.run();
		if (metadata === "legacy") {
			await fixture.raw.prepare("UPDATE snapshots SET content_meta=NULL").run();
			await fixture.raw.prepare("UPDATE factory_resources SET content_meta=NULL").run();
		}
		for (const route of routes) {
			const before = await request(beforeApp, route);
			const after = await request(afterApp, route);
			if (!/invalid|removed-history|fixture\/missing/.test(route))
				assert.equal(before.status, 200, `${metadata} ${route} fixture must exercise success`);
			for (const key of ["status", "body", "etag", "privateHeaders"] as const)
				assert.equal(after[key], before[key], `${metadata} ${route} ${key}`);
			if (before.etag) {
				const conditionalBefore = await request(beforeApp, route, before.etag);
				const conditionalAfter = await request(afterApp, route, before.etag);
				for (const key of ["status", "body", "etag", "privateHeaders"] as const)
					assert.equal(conditionalAfter[key], conditionalBefore[key], `${route} 304 ${key}`);
				assert.equal(conditionalAfter.status, 304);
			}
			const { body: beforeBody, ...beforeMetrics } = before;
			const { body: afterBody, ...afterMetrics } = after;
			assert.equal(beforeBody, afterBody);
			console.log(
				JSON.stringify({
					baselineSha,
					metadata,
					route,
					before: beforeMetrics,
					after: afterMetrics,
				}),
			);
		}
	}
} finally {
	globalThis.Date = OriginalDate;
	globalThis.fetch = originalFetch;
	revision.close();
}
