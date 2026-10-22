import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { profileDb } from "../../../../../tests/fixtures/profile-db";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import { REPO_SNAPSHOT_TABS } from "../../lib/snapshot-kinds";
import type { Env } from "../env";
import { createApp } from "../index";
import { savedContentMeta } from "./content-version";
import { createDb } from "./db/d1";
import { replaceSnapshotStmts } from "./db/snapshots";
import {
	readFactoryResource,
	readMachineFactoryStream,
	readMachineRepositoryObservation,
	readObservation,
} from "./machine-observations";
import { factoryStreamReadPlan, repositoryReadPlan } from "./saved-repository-read";

const account = "a".repeat(21);
const at = "2026-10-20T12:00:00.000Z";
async function fixture(source: "run" | "legacy" = "run") {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES(?,'nocoo','fake','fake',1,?,?)",
		)
		.bind(account, at, at)
		.run();
	const save = async (kind: string, data: Record<string, unknown>) => {
		const db = createDb(raw);
		await db.batch(await replaceSnapshotStmts(db, account, kind, data, at));
	};
	await save("repos", {
		repos: [{ name_with_owner: "nocoo/app", is_fork: true, is_archived: true }],
	});
	await raw
		.prepare("INSERT INTO repo_stars(account_id,repo) VALUES(?,'NOCOO/APP')")
		.bind(account)
		.run();
	const snap = factoryFixture();
	snap.runId = "publication";
	const repo = snap.repos[0];
	if (!repo) throw new Error("fixture repo");
	repo.observation = {
		source,
		version: "evidence",
		repo: "NOCOO/original",
		window: { since: "2026-07-01T00:00:00.000Z", until: at },
		refreshedAt: at,
	};
	for (const stream of FACTORY_STREAMS)
		repo.coverage[stream] = { ...repo.coverage[stream], status: "complete", fetchedAt: at };
	await save("factory:v:publication", snap);
	await raw
		.prepare(
			"INSERT INTO factory_state(account_id,published_id,next_at) VALUES(?,'publication','t')",
		)
		.bind(account)
		.run();
	await raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('evidence',?,'evidence','completed','{}','t','t','t')",
		)
		.bind(account)
		.run();
	for (const stream of FACTORY_STREAMS) {
		const data = {
			runId: "evidence",
			items: [],
			ranges: [snap.window],
			coverage: repo.coverage[stream],
			next: null,
		};
		if (source === "run")
			await raw
				.prepare(
					"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) VALUES('evidence','NOCOO/original',?,?,?)",
				)
				.bind(
					stream,
					JSON.stringify(data),
					await savedContentMeta(`factory:${repo.name}:${stream}`, data),
				)
				.run();
		else await save(`factory:NOCOO/original:${stream}`, data);
	}
	return { raw, save, snap, repo };
}
async function browser(raw: D1Database, path: string) {
	return createApp().request(`http://localhost/api/${path}`, {}, {
		DB: raw,
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://fixture",
	} as Env);
}

it.each(FACTORY_STREAMS)(
	"batches browser immutable %s reads without changing bytes",
	async (stream) => {
		for (const source of ["run", "legacy"] as const) {
			const s = await fixture(source);
			for (const scope of ["all", "starred"]) {
				const path = `factory/repos/NoCoo/App/${stream}?scope=${scope}`;
				const expected = await (await browser(s.raw, path)).text();
				const profile = profileDb(s.raw);
				const response = await browser(profile.raw, path);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe(expected);
				expect(profile.trips).toHaveLength(1);
				expect(profile.trips[0]?.statements).toBeGreaterThan(1);
			}
		}
	},
);

it.each(FACTORY_STREAMS)(
	"batches narrow machine immutable %s reads without changing provenance",
	async (stream) => {
		for (const source of ["run", "legacy"] as const) {
			const s = await fixture(source);
			const expected = await readFactoryResource(createDb(s.raw), account, "NOCOO/APP", stream);
			const profile = profileDb(s.raw);
			const actual = await readFactoryResource(createDb(profile.raw), account, "NOCOO/APP", stream);
			expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
			expect(actual.sourceVersion).toBe("evidence");
			expect(actual.data.ranges).toEqual([s.repo.observation?.window]);
			expect(profile.trips).toHaveLength(1);
		}
	},
);

it("leaves browser removed-history access at 200 with two trips and no catalog guard", async () => {
	const s = await fixture();
	await s.save("repo:NoCoo/Removed:issues", { issues: [{ number: 1 }] });
	const profile = profileDb(s.raw);
	const response = await browser(profile.raw, "repos/nocoo/removed/issues");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ issues: [{ number: 1 }] });
	expect(profile.trips).toHaveLength(2);
});

it("preserves browser validation, inventory and source error priority", async () => {
	const s = await fixture();
	await s.raw.prepare("UPDATE snapshots SET payload='invalid-json' WHERE kind='repos'").run();
	for (const [path, code, message] of [
		["factory/repos/nocoo/app/unknown", 400, "unknown stream"],
		["factory/repos/nocoo/app/prs?page=0", 400, "invalid page"],
		["factory/repos/nocoo/missing/prs", 404, "repository outside factory inventory"],
	] as const) {
		const response = await browser(s.raw, path);
		expect(response.status).toBe(code);
		expect(await response.json()).toMatchObject({ error: { message } });
	}
	await s.save("repos", { repos: [{ name_with_owner: "nocoo/app" }] });
	await s.raw.prepare("DELETE FROM factory_resources WHERE stream='prs'").run();
	const missing = await browser(s.raw, "factory/repos/nocoo/app/prs?day=invalid");
	expect(missing.status).toBe(409);
	expect(await missing.json()).toMatchObject({
		error: { message: "referenced resource unavailable" },
	});
});

it("keeps pending legacy browser coverage empty without parsing an unused corrupt resource", async () => {
	const s = await fixture("legacy");
	s.repo.coverage.prs.status = "pending";
	await s.save("factory:v:publication", s.snap);
	await s.raw
		.prepare("UPDATE snapshots SET payload='invalid-json' WHERE kind='factory:NOCOO/original:prs'")
		.run();
	const response = await browser(s.raw, "factory/repos/nocoo/app/prs");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		items: [],
		total: 0,
		coverage: { status: "pending" },
	});
});

it("does not decode run content metadata on the browser path", async () => {
	const s = await fixture();
	await s.raw.prepare("UPDATE factory_resources SET content_meta='invalid-json'").run();
	expect((await browser(s.raw, "factory/repos/nocoo/app/prs")).status).toBe(200);
	await expect(
		readFactoryResource(createDb(s.raw), account, "nocoo/app", "prs"),
	).rejects.toBeInstanceOf(SyntaxError);
});

it.each(REPO_SNAPSHOT_TABS)(
	"reads guarded machine %s detail in one batch with stored alias metadata",
	async (tab) => {
		const s = await fixture();
		await s.save(`repo:NOCOO/APP:${tab}`, { marker: tab });
		const expected = await readObservation(
			createDb(s.raw),
			account,
			`repo:nocoo/app:${tab}`,
			"all",
		);
		const profile = profileDb(s.raw);
		const actual = await readMachineRepositoryObservation(
			createDb(profile.raw),
			account,
			"NoCoo/App",
			tab,
		);
		expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		expect(actual.source.resource).toBe(`repo:NOCOO/APP:${tab}`);
		expect(profile.trips).toHaveLength(1);
		expect(profile.queries).toHaveLength(2);
	},
);

it("keeps machine catalog guards ahead of saved source and stream errors", async () => {
	const s = await fixture();
	await expect(
		readMachineRepositoryObservation(createDb(s.raw), account, "nocoo/app", "details"),
	).rejects.toMatchObject({ status: 409, message: "no saved source" });
	await s.save("repo:nocoo/removed:issues", { issues: [] });
	await expect(
		readMachineRepositoryObservation(createDb(s.raw), account, "nocoo/removed", "issues"),
	).rejects.toMatchObject({ status: 404, message: "repository outside saved account catalog" });
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/removed", "invalid"),
	).rejects.toMatchObject({ status: 404, message: "repository outside saved account catalog" });
	await s.raw
		.prepare("UPDATE snapshots SET payload='invalid-json' WHERE kind='factory:v:publication'")
		.run();
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/app", "invalid"),
	).rejects.toMatchObject({ status: 400, message: "unknown stream" });
	await s.raw.prepare("UPDATE snapshots SET payload='invalid-json' WHERE kind='repos'").run();
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/app", "invalid"),
	).rejects.toBeInstanceOf(SyntaxError);
	await expect(
		readMachineRepositoryObservation(createDb(s.raw), account, "nocoo/app", "issues"),
	).rejects.toBeInstanceOf(SyntaxError);
});

async function splitSaved(raw: D1Database, kind: string, key: string) {
	const row = await raw
		.prepare("SELECT payload,content_meta FROM snapshots WHERE account_id=? AND kind=?")
		.bind(account, kind)
		.first<{ payload: string; content_meta: string | null }>();
	if (!row) throw new Error("fixture split root");
	const data = JSON.parse(row.payload);
	await raw
		.prepare("UPDATE snapshots SET payload=? WHERE account_id=? AND kind=?")
		.bind(JSON.stringify({ ...data, [key]: [] }), account, kind)
		.run();
	await raw
		.prepare(
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) VALUES(?,?,?,?,?)",
		)
		.bind(account, `${kind}#2`, row.payload, at, row.content_meta)
		.run();
}

it.each(["run", "legacy"] as const)(
	"resolves %s references from second publication/catalog pages and preserves retained windows",
	async (source) => {
		const s = await fixture(source);
		s.repo.coverage.prs = { ...s.repo.coverage.prs, retained: true, status: "limited" };
		await s.save("factory:v:publication", s.snap);
		await splitSaved(s.raw, "repos", "repos");
		await splitSaved(s.raw, "factory:v:publication", "repos");
		if (source === "legacy") await splitSaved(s.raw, "factory:NOCOO/original:prs", "items");
		for (const metadata of ["stored", "mismatched", "legacy"]) {
			if (metadata === "mismatched")
				await s.raw.prepare("UPDATE snapshots SET content_meta='{}' WHERE kind LIKE '%#2'").run();
			if (metadata === "legacy") {
				await s.raw.prepare("UPDATE snapshots SET content_meta=NULL").run();
				await s.raw.prepare("UPDATE factory_resources SET content_meta=NULL").run();
			}
			const profile = profileDb(s.raw);
			const actual = await readMachineFactoryStream(
				createDb(profile.raw),
				account,
				"NOCOO/APP",
				"prs",
			);
			expect(actual.sourceVersion).toBe("evidence");
			expect(actual.data.ranges).toEqual([s.repo.observation?.window]);
			expect(actual.coverage).toEqual(s.repo.coverage.prs);
			expect(actual.truncated).toBe(true);
			expect(profile.trips).toHaveLength(1);
			expect(profile.queries.at(-1)?.rows).toBe(source === "run" ? 1 : 2);
			if (metadata === "legacy" || (source === "legacy" && metadata === "mismatched"))
				expect(actual.contentVersion).toBeNull();
			expect((await browser(s.raw, "factory/repos/nocoo/app/prs")).status).toBe(200);
		}
	},
);

it("never substitutes another account or a newer immutable resource", async () => {
	const s = await fixture();
	await s.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('other','other','fake','fake','t','t')",
		)
		.run();
	await s.raw
		.prepare(
			"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES('foreign','other','foreign','completed','{}','t','t','t')",
		)
		.run();
	await s.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('foreign','NOCOO/original','prs','invalid-json')",
		)
		.run();
	s.repo.observation = {
		...s.repo.observation,
		source: "run",
		version: "foreign",
		window: s.snap.window,
		refreshedAt: at,
	};
	await s.save("factory:v:publication", s.snap);
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/app", "prs"),
	).rejects.toMatchObject({
		status: 409,
		message: "immutable source missing; refresh this repository",
	});
	s.repo.observation.version = "evidence";
	await s.save("factory:v:publication", s.snap);
	await s.raw
		.prepare("UPDATE factory_resources SET payload=? WHERE run_id='evidence' AND stream='prs'")
		.bind(JSON.stringify({ runId: "newer", items: [] }))
		.run();
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/app", "prs"),
	).rejects.toMatchObject({
		status: 409,
		message: "immutable source version mismatch; refresh this repository",
	});
});

it("preserves catalog-before-stream checks and original versions with a different active account", async () => {
	const s = await fixture();
	await s.raw.prepare("UPDATE accounts SET is_active=0").run();
	await s.raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('other','other','fake','fake',1,'t','t')",
		)
		.run();
	const profile = profileDb(s.raw);
	const actual = await readMachineFactoryStream(
		createDb(profile.raw),
		account,
		"nocoo/app",
		"commits",
	);
	expect(actual.account_id).toBe(account);
	expect(actual.sourceVersion).toBe("evidence");
	expect(profile.trips).toHaveLength(1);
	expect((await browser(s.raw, "factory/repos/nocoo/app/unknown")).status).toBe(400);
});

it("rejects incomplete batch results instead of fabricating empty sources", () => {
	const db = createDb(sqliteFixture());
	expect(() => repositoryReadPlan(db, account, "nocoo/app", "prs").decode([])).toThrow(
		"incomplete repository batch",
	);
	expect(() => factoryStreamReadPlan(db, account, "nocoo/app", "prs").decode([])).toThrow(
		"incomplete stream batch",
	);
});

it("checks the active account before browser stream validation", async () => {
	const s = await fixture();
	await s.raw.prepare("UPDATE accounts SET is_active=0").run();
	const profile = profileDb(s.raw);
	const response = await browser(profile.raw, "factory/repos/nocoo/app/invalid");
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ error: { message: "no active account" } });
	expect(profile.trips).toHaveLength(1);
});

it("does not turn machine catalog membership into an owned-repository guard", async () => {
	const s = await fixture();
	await s.save("repos", { repos: [{ name_with_owner: "outside/app" }] });
	await s.save("repo:OUTSIDE/APP:details", { marker: "external" });
	s.repo.name = "outside/app";
	await s.save("factory:v:publication", s.snap);
	expect(
		(await readMachineRepositoryObservation(createDb(s.raw), account, "outside/app", "details"))
			.data.marker,
	).toBe("external");
	expect(
		(await readMachineFactoryStream(createDb(s.raw), account, "outside/app", "prs")).sourceVersion,
	).toBe("evidence");
	expect((await browser(s.raw, "factory/repos/outside/app/prs")).status).toBe(404);
});

it("mirrors the saved assembler when a different first array owns the second page", async () => {
	const s = await fixture();
	await s.save("factory:v:publication", { other: [], ...s.snap, repos: [] });
	await s.save("factory:v:publication#2", s.snap);
	await expect(
		readMachineFactoryStream(createDb(s.raw), account, "nocoo/app", "prs"),
	).rejects.toMatchObject({ status: 404, message: "repository outside publication" });
	expect((await browser(s.raw, "factory/repos/nocoo/app/prs")).status).toBe(404);
});
