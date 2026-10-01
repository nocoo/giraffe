import type { Db } from "./db/d1";
import { ApiError } from "./errors";

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
		.prepare("SELECT repo FROM repo_stars WHERE account_id=? ORDER BY repo")
		.bind(account)
		.all<{ repo: string }>();
	const names = new Set(rows.results.map((row) => row.repo.toLowerCase()));
	const starred = (name: string) => names.has(name.toLowerCase());
	return {
		scope,
		starred,
		empty: scope === "starred" && names.size === 0,
		includes: (name: string) => scope === "all" || starred(name),
	};
}
