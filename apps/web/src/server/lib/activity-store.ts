import { z } from "zod";
import type { ActivitySnapshot } from "../../lib/activity-types";
import type { readActivityTotals } from "./activity-totals";
import type { Db } from "./db/d1";
import { resolveFactoryRunReference } from "./db/factory-runs";
import { ApiError } from "./errors";

const querySchema = z
	.object({
		run: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/)
			.optional(),
		repository: z
			.string()
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
			.max(200)
			.optional(),
	})
	.strict();
export async function readActivity(
	db: Db,
	account: string,
	query: Record<string, string[]>,
): Promise<ActivitySnapshot & ReturnType<typeof readActivityTotals>> {
	if (Object.values(query).some((values) => values.length !== 1))
		throw new ApiError(400, "validation_failed", "Duplicate activity filter");
	const parsed = querySchema.safeParse(
		Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0]])),
	);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid activity filters");
	if (parsed.data.run !== undefined) await resolveFactoryRunReference(db, account, parsed.data.run);
	if (parsed.data.repository) {
		const repo = await db
			.prepare(
				"SELECT repo_id FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1",
			)
			.bind(account, parsed.data.repository)
			.first();
		if (!repo) throw new ApiError(404, "not_found", "Repository outside current refresh catalog");
	}
	throw new ApiError(
		409,
		"activity_unpublished",
		"Author-specific activity is unavailable from daily repository total observations",
	);
}
