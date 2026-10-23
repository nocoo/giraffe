import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { FACTORY_STREAMS, type FactoryStreamData } from "../../lib/factory-types";
import type { Env } from "../env";
import { createApp } from "../index";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { claimRun, publishedFactory, saveRun, startRun } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { mapDependencies } from "./factory-map";
import { publicationWrites, repositoryWrites } from "./factory-publish";
import { readFactoryResource } from "./machine-observations";
import { readSources } from "./machine-sources";

const limit = {
	status: "limited",
	reason_code: "dependency_parse_unsupported",
	reason: "Dependency manifests cannot be parsed safely; evidence unavailable",
} as const;

it.each([
	["run", true, false],
	["legacy", true, false],
	["run", false, false],
	["run", "mismatch", false],
	["run", true, true],
] as const)(
	"freezes retained dependency limits across attempts and recovery (%s, hash=%s, empty=%s)",
	async (source, hashed, empty) => {
		const raw = sqliteFixture();
		const snap = factoryFixture();
		const account = snap.account_id;
		const repo = snap.repos[0];
		if (!repo) throw new Error("fixture");
		snap.runId = "original";
		snap.status = "complete";
		snap.publication = { mixed: false, runId: "original", publishedAt: snap.fetched_at };
		repo.observation = {
			version: "original",
			window: snap.window,
			refreshedAt: snap.fetched_at,
			source,
		};
		for (const stream of FACTORY_STREAMS)
			Object.assign(repo.coverage[stream], { status: "complete", fetchedAt: snap.fetched_at });
		const evidence = mapDependencies(
			{
				package: {
					text: JSON.stringify({ name: "own", dependencies: empty ? {} : { external: "^1" } }),
				},
			},
			repo,
		);
		repo.dependencies = evidence.items.map((item) => ({
			name: item.title,
			version: item.version ?? "",
			path: item.path ?? "",
			url: item.url,
		}));
		repo.manifests = evidence.manifests;
		repo.coverage.dependencies.observed = evidence.items.length;
		if (empty) Object.assign(repo.coverage.dependencies, limit);
		const data: FactoryStreamData = {
			runId: "original",
			...evidence,
			next: null,
			ranges: [],
			coverage: repo.coverage.dependencies,
		};
		const db = createDb(raw);
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'nocoo','fake','fake',1,'t','t')",
			)
			.bind(account)
			.run();
		await db.batch(
			await replaceSnapshotStmts(
				db,
				account,
				"repos",
				{ repos: [{ name_with_owner: repo.name }] },
				snap.fetched_at,
			),
		);
		await db.batch(
			await replaceSnapshotStmts(db, account, "factory:v:original", snap, snap.fetched_at),
		);
		await db
			.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'original',?)")
			.bind(account, snap.fetched_at)
			.run();
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('original',?,'original','completed','{}',?,?,?)",
			)
			.bind(account, snap.fetched_at, snap.fetched_at, snap.fetched_at)
			.run();
		await db
			.prepare(
				"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES(?,?,'original',?,?)",
			)
			.bind(account, repo.name, JSON.stringify(repo), snap.fetched_at)
			.run();
		await db
			.prepare(
				"INSERT INTO factory_repo_state(account_id,repo,version,payload) VALUES(?,?,'original',?)",
			)
			.bind(
				account,
				repo.name,
				JSON.stringify({
					repo: repo.name,
					version: "original",
					observation: repo.observation,
					refreshedAt: snap.fetched_at,
					status: "success",
					nextAllowedAt: snap.fetched_at,
				}),
			)
			.run();
		const metadata = hashed
			? await savedContentMeta(`factory:${repo.name}:dependencies`, data, snap.window)
			: null;
		if (source === "run")
			await db
				.prepare(
					"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('original',?,'dependencies',?,?)",
				)
				.bind(
					repo.name,
					JSON.stringify(data),
					hashed === "mismatch" && metadata
						? JSON.stringify({ ...JSON.parse(metadata), version: "different" })
						: metadata,
				)
				.run();
		else {
			await db.batch(
				await replaceSnapshotStmts(
					db,
					account,
					`factory:${repo.name}:dependencies`,
					data,
					snap.fetched_at,
				),
			);
		}
		const originalRows = await raw
			.prepare("SELECT * FROM factory_repo_versions ORDER BY version")
			.all();
		const originalResources = await raw
			.prepare("SELECT * FROM factory_resources ORDER BY run_id")
			.all();
		const baseline = await readFactoryResource(createDb(raw), account, repo.name, "dependencies");
		const originalPublication = await raw
			.prepare("SELECT * FROM snapshots WHERE kind='factory:v:original'")
			.all();
		let lastHash: string | null = null;
		let firstPublication: unknown;
		for (const [index, id] of ["limited-1", "limited-2", "failed", "recovered"].entries()) {
			const recovery = id === "recovered";
			const failure = id === "failed";
			const at = new Date(Date.parse(snap.fetched_at) + (index + 1) * 3600000).toISOString();
			const run = makeRun(id, account, "nocoo", id, "refresh", [repo], at, [], [], {
				scope: "selected",
			});
			for (const step of run.steps) step.status = "success";
			if (!recovery)
				Object.assign(run.steps.find((step) => step.kind === "dependencies") ?? {}, {
					status: "limited",
					error: limit.reason_code,
				});
			await startRun(createDb(raw), run);
			const writer = createDb(raw);
			const lease = await claimRun(writer, id, at);
			if (!lease) throw new Error("lease");
			const candidate = structuredClone(repo);
			candidate.observation = {
				...repo.observation,
				source: "run",
				version: id,
				window: run.window,
				refreshedAt: at,
			};
			if (!recovery) {
				Object.assign(candidate.coverage.dependencies, limit, { fetchedAt: at, observed: 0 });
				candidate.dependencies = [];
			} else {
				Object.assign(candidate.coverage.dependencies, {
					status: "complete",
					reason: null,
					fetchedAt: at,
				});
				delete candidate.coverage.dependencies.reason_code;
				const recovered = { ...data, runId: id, coverage: candidate.coverage.dependencies };
				await raw
					.prepare(
						"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES(?,?,'dependencies',?,?)",
					)
					.bind(
						id,
						repo.name,
						JSON.stringify(recovered),
						await savedContentMeta(`factory:${repo.name}:dependencies`, recovered, run.window),
					)
					.run();
			}
			const before = await readFactoryResource(createDb(raw), account, repo.name, "dependencies");
			await writer.batch(
				await repositoryWrites(
					writer,
					lease,
					at,
					failure ? null : candidate,
					repo.name,
					failure ? "github_error" : null,
				),
			);
			expect(await readFactoryResource(createDb(raw), account, repo.name, "dependencies")).toEqual(
				before,
			);
			if (failure)
				Object.assign(lease.run.steps[0] ?? {}, { status: "failed", error: "github_error" });
			const writes = await publicationWrites(writer, lease, at);
			lease.run.status = failure ? "partial" : "completed";
			lease.run.finishedAt = at;
			expect(await saveRun(writer, lease, writes, at)).toBe(true);
			const stream = await readFactoryResource(createDb(raw), account, repo.name, "dependencies");
			const profile = profileDb(raw);
			const reader = createDb(profile.raw);
			const indexed = (await readSources(reader, account, {})).sources.find(
				(item) => item.resource === `factory:${repo.name}:dependencies`,
			);
			expect(reader.statements).toBeLessThanOrEqual(7);
			expect(
				profile.queries.find((query) => query.sql.includes("CROSS JOIN factory_resources"))
					?.payloadBytes,
			).toBe(0);
			expect(indexed).toMatchObject({
				version: stream.sourceVersion,
				contentVersion: stream.contentVersion,
				fetchedAt: stream.fetchedAt,
				coverage: stream.coverage,
				truncated: stream.truncated,
				unavailable: stream.unavailable,
			});
			const browser = await createApp().request(
				`http://localhost/api/factory/repos/nocoo/app/dependencies`,
				{},
				{ DB: raw, ENVIRONMENT: "development", GITHUB_API_BASE: "http://fixture" } as Env,
			);
			expect(browser.status).toBe(200);
			expect(await browser.json()).toMatchObject({
				coverage: stream.coverage,
				items: stream.data.items,
			});
			expect(stream.data.items).toEqual(baseline.data.items);
			expect(stream.data.manifests).toEqual(baseline.data.manifests);
			if (!recovery) {
				expect(stream).toMatchObject({
					sourceVersion: "original",
					fetchedAt: snap.fetched_at,
					truncated: true,
					coverage: { ...limit, observed: evidence.items.length, fetchedAt: snap.fetched_at },
					data: { observation: repo.observation, ranges: [snap.window] },
				});
				if (hashed === true) {
					expect(stream.contentVersion).toMatch(/^sha256:/);
					expect(stream.contentVersion).not.toBe(baseline.contentVersion);
				} else expect(stream.contentVersion).toBeNull();
				if (index > 0) expect(stream.contentVersion).toBe(lastHash);
				lastHash = stream.contentVersion;
				expect(
					await raw
						.prepare(
							"SELECT * FROM factory_repo_versions WHERE version='original' ORDER BY version",
						)
						.all(),
				).toEqual(originalRows);
				expect(
					await raw
						.prepare("SELECT * FROM factory_resources WHERE run_id='original' ORDER BY run_id")
						.all(),
				).toEqual(originalResources);
				expect(
					await raw
						.prepare("SELECT version FROM factory_version_refs WHERE publication_id=?")
						.bind(id)
						.all(),
				).toMatchObject({ results: [{ version: failure ? "limited-2" : id }] });
			} else {
				expect(stream).toMatchObject({
					sourceVersion: id,
					fetchedAt: at,
					truncated: false,
					coverage: { status: "complete", reason: null },
					data: { ranges: [run.window] },
				});
				expect(stream.coverage).not.toHaveProperty("retained");
			}
			expect((await publishedFactory(createDb(raw), account))?.status).toBe(
				failure ? "partial" : "complete",
			);
			if (index === 0)
				firstPublication = await raw
					.prepare("SELECT * FROM snapshots WHERE kind='factory:v:limited-1'")
					.all();
			else
				expect(
					await raw.prepare("SELECT * FROM snapshots WHERE kind='factory:v:limited-1'").all(),
				).toEqual(firstPublication);
		}
		expect(
			await raw.prepare("SELECT * FROM snapshots WHERE kind='factory:v:original'").all(),
		).toEqual(originalPublication);
	},
);
