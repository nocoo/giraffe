import {
	beginCatalog,
	catalogPlanWrites,
	planCatalog,
} from "../../apps/web/src/server/lib/catalog-history";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import { github } from "./factory";
import { sqliteFixture } from "./sqlite";

export const before = "2026-10-21T00:00:00.000Z";
export const now = "2026-10-22T00:00:00.000Z";
export const later = "2026-10-23T00:00:00.000Z";
export const proof = {
	name_with_owner: "nocoo/private-proof",
	visibility: "PRIVATE",
	is_private: true,
};
export const missing = { name_with_owner: "nocoo/old", visibility: "PUBLIC", is_private: false };
type Row = typeof missing;

export async function fixture(privateBefore = false, withProof = true) {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','nocoo','fake','fake',?,?)",
		)
		.bind(before, before)
		.run();
	await raw
		.prepare(
			"INSERT INTO catalog_state(account_id,history_since,checked_at,revision) VALUES('a',?,?,1)",
		)
		.bind(before, before)
		.run();
	for (const [id, row] of [
		[
			"R_OLD",
			{ ...missing, visibility: privateBefore ? "PRIVATE" : "PUBLIC", is_private: privateBefore },
		],
		...(withProof ? [["R_PROOF", proof]] : []),
	] as [string, Row][]) {
		await raw
			.prepare(
				"INSERT INTO catalog_repositories(account_id,identity_key,github_id,repo,row_payload,first_seen_at,last_seen_at,is_archived,visibility,is_fork,first_seen_source) VALUES('a',?,?,?,?,?,?,0,?,0,'github_catalog')",
			)
			.bind(id, id, row.name_with_owner, JSON.stringify(row), before, before, row.visibility)
			.run();
	}
	await raw
		.prepare(
			"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES('a','nocoo/old',0,'owner',?,'keep tombstone')",
		)
		.bind(before)
		.run();
	await raw.prepare("INSERT INTO repo_statistics VALUES('a','nocoo/old',0)").run();
	await raw
		.prepare("INSERT INTO factory_repo_state VALUES('a','nocoo/old','original',?)")
		.bind(
			JSON.stringify({
				repo: "nocoo/old",
				status: "success",
				observation: { source: "run", repo: "nocoo/old", version: "original" },
			}),
		)
		.run();
	const saved = async () =>
		Promise.all(
			["repo_stars", "repo_statistics", "factory_repo_state"].map((table) =>
				raw.prepare(`SELECT * FROM ${table} ORDER BY repo`).all(),
			),
		);
	const original = await saved();
	async function plan(
		response: () => Response | Promise<Response>,
		rows: Row[] = withProof ? [proof] : [],
		ids: Record<string, string> = { "nocoo/private-proof": "R_PROOF" },
		at = now,
	) {
		const requests: { query: string; variables: Record<string, unknown> }[] = [];
		const gh = github((_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return response();
		});
		const result = await planCatalog(
			await beginCatalog(createDb(raw), "a"),
			{ repos: rows, truncated: false },
			ids,
			"nocoo",
			gh,
			"fixture",
			at,
			{ kind: "legacy", runId: null },
		);
		return { result, requests, gh };
	}
	const publish = (result: Awaited<ReturnType<typeof plan>>["result"]) => {
		const requestDb = createDb(raw);
		return requestDb.batch(catalogPlanWrites(requestDb, "a", result));
	};
	return { raw, db, plan, publish, saved, original };
}

export const safeNotFound = () =>
	Response.json({
		data: { node: null },
		errors: [
			{
				type: "NOT_FOUND",
				message: "Could not resolve to a node with the global id of 'R_OLD'",
				path: ["node"],
			},
		],
	});
