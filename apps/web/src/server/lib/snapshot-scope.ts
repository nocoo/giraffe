import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import type { StarRow } from "./repo-stars";

export type SnapshotScope = "all" | "starred";

export function snapshotScope(value: string | string[] | undefined): SnapshotScope {
	if (value === undefined) return "all";
	if (Array.isArray(value)) {
		if (value.length !== 1) throw new ApiError(400, "validation_failed", "invalid scope");
		return snapshotScope(value[0]);
	}
	if (value === "all" || value === "starred") return value;
	throw new ApiError(400, "validation_failed", "invalid scope");
}

export async function snapshotSelection(db: Db, account: string, scope: SnapshotScope) {
	const rows = await db
		.prepare(
			"SELECT repo,starred,source,updated_at,reason FROM repo_stars WHERE account_id=? ORDER BY repo",
		)
		.bind(account)
		.all<StarRow>();
	return selectionFromStars(rows.results, scope);
}

export function selectionFromStars(rows: StarRow[], scope: SnapshotScope) {
	const names = new Set(
		rows.filter((row) => row.starred === 1).map((row) => row.repo.toLowerCase()),
	);
	const records = new Map(rows.map((row) => [row.repo.toLowerCase(), row]));
	const starred = (name: string) => names.has(name.toLowerCase());
	return {
		scope,
		starred,
		starRecord: (name: string) => records.get(name.toLowerCase()) ?? null,
		empty: scope === "starred" && names.size === 0,
		includes: (name: string) => scope === "all" || starred(name),
	};
}
