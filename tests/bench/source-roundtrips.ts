import assert from "node:assert/strict";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { readSources } from "../../apps/web/src/server/lib/machine-sources";
import { SourceTiming } from "../../apps/web/src/server/lib/source-timing";
import { profileDb } from "../fixtures/profile-db";
import { revisionFixture } from "../fixtures/revision";
import { populateSourceStreams, sourcesFixture } from "../fixtures/sources";

const revision = process.argv[2] ?? "9bbecde5b3a8037e5a44b8e9e2e9610dcb71cff3";
const modulePath = "apps/web/src/server/lib/machine-sources.ts";
const historical = [
	{ label: "main-0.17.3", revision: "9b95192310339dd96d55d4440e3332a4f5aea5bc" },
	{ label: "release-0.17.2", revision: "86f39d3549e0f84e08abb10d822367e8f8352872" },
	{ label: "functional-baseline", revision },
	{ label: "rejected-projection", revision: "d6733075f7401c0411cd96cbe1c896c9ddd39f40" },
];
const revisions: ReturnType<typeof revisionFixture>[] = [];
const sampleCount = 15;
const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("source round-trip benchmark forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

try {
	const variants: { label: string; revision: string; reader: typeof readSources }[] = [];
	for (const entry of historical) {
		const archived = revisionFixture(entry.revision);
		revisions.push(archived);
		const loaded = await archived.load<{ readSources: typeof readSources }>(modulePath);
		variants.push({ ...entry, reader: loaded.readSources });
	}
	variants.push({ label: "final", revision: "working-tree", reader: readSources });
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
			variants: variants.map(({ label, revision: sourceRevision }) => ({
				label,
				revision: sourceRevision,
			})),
			sampleCount,
			order: "alternating forward/reverse variant order per round",
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
				.filter((metric) => metric.includes(";dur="))
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
	type Sample = Awaited<ReturnType<typeof sample>>;
	const metrics = [
		"d1Ms",
		"sqliteMs",
		"buildMs",
		"buildWithoutD1Ms",
		"decodeMs",
		"hashProjectionMs",
		"serializeMs",
		"totalMs",
	] as const;
	function summary(samples: Sample["stats"][]) {
		return Object.fromEntries(
			metrics.map((metric) => {
				const values = samples.map((row) => row[metric]).filter((value) => value !== null);
				assert.equal(values.length, sampleCount);
				assert.ok(values.every(Number.isFinite));
				values.sort((first, second) => first - second);
				return [
					metric,
					{
						median: values[Math.floor(values.length / 2)],
						p95: values[Math.ceil(values.length * 0.95) - 1],
					},
				];
			}),
		);
	}

	for (const [scenario, query] of Object.entries({
		full: {},
		"since-two-thirds": { since: "2026-10-19T00:00:00.000Z" },
		"since-empty": { since: "2026-10-21T00:00:00.000Z" },
		"one-repository": { repository: "FIXTURE/PROJECT-001" },
	})) {
		const cold = new Map<string, Sample>();
		const samples = new Map<string, Sample["stats"][]>();
		for (const variant of variants) {
			cold.set(variant.label, await sample(variant.reader, query, 0, true));
			samples.set(variant.label, []);
		}
		const functional = cold.get("functional-baseline");
		const final = cold.get("final");
		assert.ok(functional && final);
		assert.equal(final.body, functional.body, `${scenario} must preserve functional-baseline JSON`);
		assert.equal(final.body, cold.get("rejected-projection")?.body);
		assert.equal(final.stats.payloadBytes, functional.stats.payloadBytes);
		const orders = [];
		for (let round = 0; round < sampleCount; round++) {
			const order: typeof variants = round % 2 === 0 ? variants : [...variants].reverse();
			orders.push(order.map(({ label }) => label));
			for (const variant of order) {
				const measured = await sample(variant.reader, query, 0, true);
				const initial = cold.get(variant.label);
				assert.ok(initial);
				assert.equal(measured.body, initial.body, `${scenario}/${variant.label} must stay stable`);
				assert.equal(measured.stats.trips, 1);
				assert.equal(measured.stats.queries, 5);
				assert.equal(measured.stats.payloadBytes, initial.stats.payloadBytes);
				samples.get(variant.label)?.push(measured.stats);
			}
		}
		console.log(
			JSON.stringify({
				scenario,
				latencyMs: 0,
				orders,
				variants: variants.map(({ label, revision: sourceRevision }) => {
					const measured = samples.get(label);
					assert.ok(measured);
					return {
						label,
						revision: sourceRevision,
						cold: cold.get(label)?.stats,
						summary: summary(measured),
						samples: measured,
					};
				}),
			}),
		);
		if (scenario === "full") {
			const statement: Sample["profile"]["queries"][number] | undefined =
				final.profile.queries.at(-1);
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
	for (const archived of revisions) archived.close();
}
