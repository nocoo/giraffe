import assert from "node:assert/strict";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactoryStreamData,
} from "../../apps/web/src/lib/factory-types";
import { savedContentMeta } from "../../apps/web/src/server/lib/content-version";
import { factoryFixture } from "./factory-snapshot";
import { sqliteFixture } from "./sqlite";

export async function sourcesFixture() {
	const raw = sqliteFixture();
	const account = "local-bench-account-01";
	const latest = "2026-10-20T12:00:00.000Z";
	const old = "2026-10-18T12:00:00.000Z";
	const names = Array.from(
		{ length: 126 },
		(_, i) => `fixture/project-${String(i).padStart(3, "0")}`,
	);
	const save = async (kind: string, data: Record<string, unknown>, at = latest) => {
		const payload = JSON.stringify({ ...data, fetched_at: at, truncated: data.truncated === true });
		await raw
			.prepare(
				"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
			)
			.bind(account, kind, payload, at, await savedContentMeta(kind, JSON.parse(payload)))
			.run();
	};
	await raw.prepare("CREATE TABLE _test_marker(key TEXT PRIMARY KEY,value TEXT NOT NULL)").run();
	await raw.prepare("INSERT INTO _test_marker(key,value) VALUES('env','test')").run();
	assert.equal(
		(await raw.prepare("SELECT value FROM _test_marker WHERE key='env'").first<{ value: string }>())
			?.value,
		"test",
	);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(?,'fixture','fake','fake',?,?)",
		)
		.bind(account, latest, latest)
		.run();
	const catalog = names.map((name, i) => ({
		name_with_owner: name,
		owner_login: "fixture",
		name: name.split("/")[1],
		is_fork: i % 19 === 0,
		is_archived: i % 23 === 0,
		description: `Deterministic application ${i}`,
		primary_language: "TypeScript",
		pushed_at: i % 3 === 0 ? old : latest,
		url: `https://github.example/${name}`,
		is_private: i % 3 === 0,
		stargazer_count: i * 3,
		open_issue_count: 40,
	}));
	await save("repos", { repos: catalog }, old);
	const snapshot = factoryFixture();
	const template = snapshot.repos[0];
	if (!template) throw new Error("missing factory template");
	snapshot.account_id = account;
	snapshot.owner = "fixture";
	snapshot.runId = "publication-local-bench";
	snapshot.fetched_at = latest;
	snapshot.startedAt = old;
	snapshot.status = "complete";
	snapshot.window = { since: "2026-07-22T00:00:00.000Z", until: latest };
	snapshot.publication = { runId: snapshot.runId, mixed: true, publishedAt: latest };
	snapshot.inventory = {
		total: 126,
		scanned: 126,
		complete: true,
		after: null,
		pages: 2,
		excluded: [],
	};
	snapshot.repos = names.map((name, i) => ({
		...structuredClone(template),
		id: `R_FIXTURE_${i}`,
		name,
		url: `https://github.example/${name}`,
		description: `Deterministic application ${i}`,
		observation: {
			version: `repo-version-${i % 9}`,
			source: "run",
			repo: name,
			window: snapshot.window,
			refreshedAt: i % 3 === 0 ? old : latest,
		},
		coverage: Object.fromEntries(
			FACTORY_STREAMS.map((stream, j) => [
				stream,
				{
					status:
						i % 17 === 0 && j === 5
							? "unavailable"
							: i % 13 === 0 && j === 1
								? "limited"
								: "complete",
					pages: (j % 2) + 1,
					fetchedAt: i % 3 === 0 ? old : latest,
					source: `REST /repos/${name}/${stream}`,
					reason: i % 17 === 0 && j === 5 ? "permission" : null,
					observed: 10 + ((i + j) % 100),
				},
			]),
		) as FactoryRepo["coverage"],
	}));
	await save(`factory:v:${snapshot.runId}`, snapshot);
	await raw
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,?,'t')")
		.bind(account, snapshot.runId)
		.run();
	const allIssues: Record<string, unknown>[] = [],
		allPrs: Record<string, unknown>[] = [];
	const recorded: Record<string, string> = {};
	for (const [i, name] of names.entries()) {
		const at = i % 3 === 0 ? old : latest;
		const issue = (j: number) => ({
			number: j + 1,
			title: `Issue ${j} for ${name}`,
			body: `Reproduction evidence for deterministic fixture ${i}/${j}. `.repeat(4),
			state: "open",
			author_login: `contributor-${j % 7}`,
			created_at: old,
			updated_at: at,
			url: `https://github.example/${name}/issues/${j + 1}`,
			labels: [{ name: "enhancement", color: "123456" }],
			comments_count: j % 5,
		});
		const issues = Array.from({ length: 40 }, (_, j) => issue(j));
		const prs = Array.from({ length: 30 }, (_, j) => ({
			...issue(j + 100),
			is_draft: j % 5 === 0,
			review_decision: "APPROVED",
			additions: 30,
			deletions: 10,
			base_ref: "main",
			head_ref: `feature/change-${j}`,
		}));
		const runs = Array.from({ length: 60 }, (_, j) => ({
			id: i * 1000 + j,
			name: ["Quality", "Tests", "Release"][j % 3],
			html_url: `https://github.example/${name}/actions/runs/${j}`,
			status: "completed",
			conclusion: j % 11 === 0 ? "failure" : "success",
			event: "push",
			head_branch: "main",
			created_at: new Date(Date.parse(at) - j * 3600000).toISOString(),
			updated_at: at,
		}));
		const releases = Array.from({ length: 12 }, (_, j) => ({
			id: i * 100 + j,
			tag_name: `v1.${j}.0`,
			name: `Release ${j}`,
			html_url: `https://github.example/${name}/releases/v1.${j}.0`,
			draft: false,
			prerelease: false,
			published_at: new Date(Date.parse(at) - j * 86400000).toISOString(),
		}));
		await save(
			`repo:${name}:details`,
			{ ...catalog[i], default_branch: "main", topics: ["fixture", "worker"], license: "MIT" },
			at,
		);
		await save(`repo:${name}:issues`, { issues }, at);
		await save(`repo:${name}:prs`, { pull_requests: prs }, at);
		await save(`repo:${name}:actions`, { runs }, at);
		await save(`repo:${name}:releases`, { releases }, at);
		recorded[name] = old;
		allIssues.push(...issues.slice(0, 6).map((row) => ({ ...row, name_with_owner: name })));
		allPrs.push(...prs.slice(0, 4).map((row) => ({ ...row, name_with_owner: name })));
		if (i % 7 === 0)
			await raw.prepare("INSERT INTO repo_stars VALUES(?,?)").bind(account, name).run();
		if (i % 11 === 0)
			await raw.prepare("INSERT INTO repo_statistics VALUES(?,?,0)").bind(account, name).run();
	}
	await save("issues", { issues: allIssues, repository_fetched_at: recorded }, old);
	await save("prs", { pull_requests: allPrs, repository_fetched_at: recorded }, old);
	// Older mixed-case aliases and removed history are intentionally retained, not indexed twice.
	for (const suffix of ["details", "issues", "prs", "actions", "releases"]) {
		const key = (
			{ issues: "issues", prs: "pull_requests", actions: "runs", releases: "releases" } as Record<
				string,
				string
			>
		)[suffix];
		await save(
			`repo:FIXTURE/PROJECT-001:${suffix}`,
			key ? { [key]: [] } : { default_branch: "old" },
			old,
		);
		await save(
			`repo:fixture/removed-history:${suffix}`,
			key ? { [key]: [] } : { default_branch: "main" },
			old,
		);
	}
	return { raw, account, names, save, latest, old, snapshot };
}

export async function populateSourceStreams(fixture: Awaited<ReturnType<typeof sourcesFixture>>) {
	const { raw, account, snapshot } = fixture;
	assert.equal(
		(await raw.prepare("SELECT value FROM _test_marker WHERE key='env'").first<{ value: string }>())
			?.value,
		"test",
	);
	const payloadBytes = new Map<string, number>();
	for (const repo of snapshot.repos) {
		const version = repo.observation?.version;
		assert.ok(version);
		await raw
			.prepare(
				"INSERT OR IGNORE INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,?,'completed','{}','t','t','t')",
			)
			.bind(version, account, version)
			.run();
		const coverage = repo.coverage.commits;
		const data: FactoryStreamData = {
			runId: version,
			next: null,
			ranges: [snapshot.window],
			coverage,
			items: Array.from({ length: coverage.observed }, (_, i) => ({
				id: `${repo.id}-${i}`,
				title: `Saved commit ${i}`,
				body: "x".repeat(Math.floor(931_000 / coverage.observed) - 300),
				url: `https://github.example/${repo.name}/commit/${i}`,
				at: fixture.old,
				createdAt: fixture.old,
				closedAt: null,
				mergedAt: null,
				author: "fixture",
				state: "committed",
			})),
		};
		const payload = JSON.stringify(data);
		const bytes = new TextEncoder().encode(payload).byteLength;
		assert.ok(bytes > 900_000 && bytes < 1_200_000);
		payloadBytes.set(repo.name, bytes);
		await raw
			.prepare(
				"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES(?,?,'commits',?,?)",
			)
			.bind(
				version,
				repo.name,
				payload,
				await savedContentMeta(`factory:${repo.name}:commits`, data, snapshot.window),
			)
			.run();
	}
	return payloadBytes;
}
