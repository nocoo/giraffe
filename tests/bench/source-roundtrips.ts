import assert from "node:assert/strict";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { readSources } from "../../apps/web/src/server/lib/machine-sources";
import { SourceTiming } from "../../apps/web/src/server/lib/source-timing";
import { profileDb } from "../fixtures/profile-db";
import { revisionFixture } from "../fixtures/revision";
import { populateSourceStreams, sourcesFixture } from "../fixtures/sources";

const revision = process.argv[2] ?? "9bbecde5b3a8037e5a44b8e9e2e9610dcb71cff3";
const modulePath = "apps/web/src/server/lib/machine-sources.ts";
const baselineRevision = revisionFixture(revision);
const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("source round-trip benchmark forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

try {
	const baseline = await baselineRevision.load<{ readSources: typeof readSources }>(modulePath);
	const fixture = await sourcesFixture();
	const streamBytes = await populateSourceStreams(fixture);
	const history = JSON.stringify({ repos: [], history: "x".repeat(16_000) });
	const historyWrites: D1PreparedStatement[] = [];
	for (let index = 0; index < 1_000; index++) {
		historyWrites.push(
			fixture.raw
				.prepare("INSERT INTO snapshots(account_id,kind,payload,fetched_at) VALUES(?,?,?,'t')")
				.bind(fixture.account, `factory:v:history-${index}`, history),
			fixture.raw
				.prepare(
					"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('repo-version-0',?,'commits',?)",
				)
				.bind(`history/repository-${index}`, history),
		);
	}
	await fixture.raw.batch(historyWrites);
	console.log(
		JSON.stringify({
			baseline: revision,
			runtime: `bun ${Bun.version}`,
			repositories: fixture.names.length,
			streamRows: streamBytes.size,
			streamPayloadBytes: [...streamBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
			historicalRows: historyWrites.length,
			historicalPayloadBytes: historyWrites.length * Buffer.byteLength(history),
			auth: "not executed; add one unchanged authenticated D1 round trip for the HTTP route",
			hash: "hash-producing projections and digest calls; includes projection CPU",
		}),
	);

	async function sample(
		reader: typeof readSources,
		query: Record<string, string>,
		latency: number,
		timed: boolean,
	) {
		const timing = new SourceTiming();
		const profile = profileDb(fixture.raw, latency);
		const started = performance.now();
		const result = await timing.measureAsync("build", () =>
			reader(createDb(profile.raw), fixture.account, query, timed ? timing : undefined),
		);
		const buildMs = performance.now() - started;
		const serializeAt = performance.now();
		const body = timing.measure("serialize", () => JSON.stringify(result));
		const serializeMs = performance.now() - serializeAt;
		const phases = Object.fromEntries(
			timing
				.header()
				.split(", ")
				.map((metric) => {
					const [name, duration] = metric.split(";dur=");
					return [name, Number(duration)];
				}),
		);
		const d1Ms = profile.trips.reduce((sum, trip) => sum + trip.ms, 0);
		return {
			body,
			profile,
			stats: {
				trips: profile.trips.length,
				queries: profile.queries.length,
				d1Ms,
				sqliteMs: profile.queries.reduce((sum, row) => sum + row.ms, 0),
				buildMs,
				buildWithoutD1Ms: buildMs - d1Ms,
				decodeMs: timed ? phases.decode : null,
				hashProjectionMs: timed ? phases.hash : null,
				serializeMs,
				totalMs: performance.now() - started,
				payloadBytes: profile.queries.reduce((sum, row) => sum + row.payloadBytes, 0),
				bodyBytes: Buffer.byteLength(body),
				bodySHA256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
			},
		};
	}

	for (const [scenario, query] of Object.entries({
		full: {},
		"since-two-thirds": { since: "2026-10-19T00:00:00.000Z" },
		"since-empty": { since: "2026-10-21T00:00:00.000Z" },
		"one-repository": { repository: "FIXTURE/PROJECT-001" },
	})) {
		const coldBefore = await sample(baseline.readSources, query, 0, true);
		const coldAfter = await sample(readSources, query, 0, true);
		assert.equal(coldAfter.body, coldBefore.body, `${scenario} must preserve exact response JSON`);
		const samples = [];
		for (let round = 0; round < 3; round++) {
			const before = await sample(baseline.readSources, query, 0, true);
			const after = await sample(readSources, query, 0, true);
			assert.equal(before.body, coldBefore.body);
			assert.equal(after.body, before.body);
			assert.equal(before.stats.trips, 1);
			assert.equal(after.stats.trips, 1);
			assert.equal(after.stats.queries, 5);
			assert.ok(after.stats.payloadBytes < before.stats.payloadBytes);
			samples.push({ round, before: before.stats, after: after.stats });
		}
		console.log(
			JSON.stringify({
				scenario,
				cold: { before: coldBefore.stats, after: coldAfter.stats },
				latencyMs: 0,
				samples,
			}),
		);
		if (scenario === "full") {
			const statement = coldAfter.profile.queries.at(-1);
			assert.ok(statement);
			const plan = await fixture.raw
				.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
				.bind(...statement.bindings)
				.all<{ detail: string }>();
			assert.ok(
				plan.results.some((row) => row.detail.includes("COVERING INDEX factory_resources_content")),
			);
			assert.ok(
				plan.results.some((row) => row.detail.includes("COVERING INDEX snapshots_content")),
			);
			assert.ok(
				!plan.results.some((row) => /SCAN (?:snapshots|factory_resources)\b/.test(row.detail)),
			);
			console.log(JSON.stringify({ queryPlan: plan.results.map((row) => row.detail) }));
		}
	}
} finally {
	globalThis.fetch = originalFetch;
	baselineRevision.close();
}
