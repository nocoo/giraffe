import { z } from "zod";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { readJson } from "./read-body";

export const starReason = z.string().max(200).optional();
const reasonInput = z.object({ reason: starReason }).strict();
export type StarRow = {
	repo: string;
	starred: number;
	source: "owner" | "agent";
	updated_at: string;
	reason: string | null;
};
const record = (row: StarRow) => ({ ...row, starred: row.starred === 1 });

export async function readStarReason(request: Request) {
	const body = await readJson(request, 2048, true);
	const parsed = reasonInput.safeParse(body === undefined ? {} : body);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid star reason");
	return parsed.data.reason ?? null;
}

export async function readStars(db: Db, account: string) {
	const rows = await db
		.prepare(
			"SELECT repo,starred,source,updated_at,reason FROM repo_stars WHERE account_id=? ORDER BY repo",
		)
		.bind(account)
		.all<StarRow>();
	return rows.results.map(record);
}

export async function writeStar(
	db: Db,
	account: string,
	repo: string,
	starred: boolean,
	source: StarRow["source"],
	reason: string | null,
	now: string,
) {
	const [written, saved] = await db.batch<StarRow>([
		db
			.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at,reason) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,repo) DO UPDATE SET starred=excluded.starred,source=excluded.source,updated_at=excluded.updated_at,reason=excluded.reason RETURNING repo,starred,source,updated_at,reason",
			)
			.bind(account, repo, Number(starred), source, now, reason),
		db
			.prepare(
				"SELECT repo,starred,source,updated_at,reason FROM repo_stars WHERE account_id=? AND repo=?",
			)
			.bind(account, repo),
	]);
	const row = saved?.results[0];
	if (!row) throw new ApiError(500, "db_error", "star result missing");
	return { item: record(row), changed: Boolean(written?.results.length) };
}
