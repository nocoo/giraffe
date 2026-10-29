import { normalizeRepoDependencies } from "../../../lib/factory-dependencies";
import type { FactorySnapshot } from "../../../lib/factory-types";
import { storedContent, withContent } from "../content-version";
import { ApiError } from "../errors";
import type { Db } from "./d1";
import { readSnapshot } from "./snapshots";

export type FactoryHead = {
	published_id: string | null;
	catalog_id: string | null;
	next_at: string;
};

export const factoryHead = (db: Db, account: string) =>
	db
		.prepare("SELECT published_id,catalog_id,next_at FROM factory_state WHERE account_id=?")
		.bind(account)
		.first<FactoryHead>();
export function normalizePublication(snapshot: FactorySnapshot): FactorySnapshot {
	return withContent(
		{ ...snapshot, repos: snapshot.repos.map(normalizeRepoDependencies) },
		storedContent(snapshot),
	) as FactorySnapshot;
}
export async function publishedFactory(db: Db, account: string): Promise<FactorySnapshot | null> {
	const head = await factoryHead(db, account);
	const snapshot = (await readSnapshot(
		db,
		account,
		head?.published_id ? `factory:v:${head.published_id}` : "factory",
	)) as FactorySnapshot | null;
	return snapshot ? normalizePublication(snapshot) : null;
}
export async function resolveFactoryRunReference(db: Db, account: string, reference: string) {
	if (reference === "latest") return reference;
	const rows = await db
		.prepare(
			"SELECT id FROM factory_runs WHERE account_id=? AND (id=? OR (length(?)<36 AND id LIKE ? || '%')) ORDER BY created_at DESC,id DESC",
		)
		.bind(account, reference, reference, reference)
		.all<{ id: string }>();
	if (!rows.results.length) throw new ApiError(404, "not_found", "Unknown activity run");
	if (rows.results.length > 1)
		throw new ApiError(400, "validation_failed", "Ambiguous run reference");
	const match = rows.results[0];
	if (!match) throw new ApiError(404, "not_found", "Unknown activity run");
	return match.id;
}
