import assert from "node:assert/strict";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { readSources } from "../../apps/web/src/server/lib/machine-sources";
import { profileDb } from "../fixtures/profile-db";
import { sourcesFixture } from "../fixtures/sources";

const { raw, account } = await sourcesFixture();
const rows = await raw
	.prepare("SELECT COUNT(*) AS n,SUM(length(CAST(payload AS BLOB))) AS bytes FROM snapshots")
	.first<{ n: number; bytes: number }>();
const scenarios: Record<string, Record<string, string>> = {
	full: {},
	"since-two-thirds": { since: "2026-10-19T00:00:00.000Z" },
	"since-empty": { since: "2026-10-21T00:00:00.000Z" },
	"one-repository": { repository: "FIXTURE/PROJECT-001" },
};
async function computationProfile(query: Record<string, string>) {
	const stats = {
		parseCount: 0,
		parseMs: 0,
		parsedBytes: 0,
		stringifyCount: 0,
		stringifyMs: 0,
		digestCount: 0,
		digestBytes: 0,
		digestSubmitMs: 0,
	};
	const parse = JSON.parse;
	const stringify = JSON.stringify;
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
		const start = performance.now();
		const value = parse(...args);
		stats.parseMs += performance.now() - start;
		stats.parseCount++;
		stats.parsedBytes += Buffer.byteLength(args[0]);
		return value;
	};
	JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
		const start = performance.now();
		const value = stringify(...args);
		stats.stringifyMs += performance.now() - start;
		stats.stringifyCount++;
		return value;
	}) as typeof JSON.stringify;
	crypto.subtle.digest = (...args: Parameters<typeof crypto.subtle.digest>) => {
		const start = performance.now();
		const promise = digest(...args);
		stats.digestSubmitMs += performance.now() - start;
		stats.digestCount++;
		stats.digestBytes += args[1].byteLength;
		return promise;
	};
	try {
		await readSources(createDb(raw), account, query);
		return stats;
	} finally {
		JSON.parse = parse;
		JSON.stringify = stringify;
		crypto.subtle.digest = digest;
	}
}

const originalFetch = globalThis.fetch;
const denyNetwork = () => {
	throw new Error("source profiling forbids network");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
try {
	console.log(
		JSON.stringify({
			runtime: `bun ${Bun.version}`,
			fixture: { repositories: 126, sources: 1517, rows: rows?.n, payloadBytes: rows?.bytes },
			warmups: 3,
			samples: 12,
		}),
	);
	for (const [scenario, query] of Object.entries(scenarios)) {
		for (let warmup = 0; warmup < 3; warmup++) await readSources(createDb(raw), account, query);
		const samples: {
			readMs: number;
			serializeMs: number;
			queryCount: number;
			sqliteMs: number;
			payloadBytes: number;
			sourceCount: number;
			bodyBytes: number;
			bodySHA256: string;
		}[] = [];
		for (let iteration = 0; iteration < 12; iteration++) {
			const profile = profileDb(raw);
			const start = performance.now();
			const result = await readSources(createDb(profile.raw), account, query);
			const readMs = performance.now() - start;
			const serialStart = performance.now();
			const body = JSON.stringify(result);
			const serializeMs = performance.now() - serialStart;
			assert.ok(profile.queries.length <= 5);
			samples.push({
				readMs,
				serializeMs,
				queryCount: profile.queries.length,
				sqliteMs: profile.queries.reduce((sum, q) => sum + q.ms, 0),
				payloadBytes: profile.queries.reduce((sum, q) => sum + q.payloadBytes, 0),
				sourceCount: result.sources.length,
				bodyBytes: Buffer.byteLength(body),
				bodySHA256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
			});
		}
		const percentile = (key: "readMs" | "serializeMs" | "sqliteMs", p: number) =>
			[...samples].sort((a, b) => a[key] - b[key])[Math.floor(samples.length * p)]?.[key];
		const computation = await computationProfile(query);
		console.log(
			JSON.stringify({
				scenario,
				computation,
				...samples[0],
				readMs: percentile("readMs", 0.5),
				readP95Ms: percentile("readMs", 0.95),
				serializeMs: percentile("serializeMs", 0.5),
				sqliteMs: percentile("sqliteMs", 0.5),
				samples,
			}),
		);
	}
} finally {
	globalThis.fetch = originalFetch;
}
