export const SCHEDULE_TABLES =
	"(SELECT * FROM refresh_schedules UNION ALL SELECT * FROM catalog_refresh_schedules)";

export function beijingDayStart(now: string): string {
	const local = new Date(Date.parse(now) + 8 * 3600_000);
	local.setUTCHours(0, 0, 0, 0);
	return new Date(local.getTime() - 8 * 3600_000).toISOString();
}

export const SCHEDULE_PRIORITY = `CASE
 WHEN kind='weekly' AND next_at=(SELECT MIN(next_at) FROM pending WHERE kind='daily') THEN 0
 WHEN kind='daily' THEN 1 ELSE 2 END,next_at,kind DESC`;

export const SCHEDULE_PENDING = `SELECT * FROM ${SCHEDULE_TABLES}
 WHERE account_id=? AND enabled=1 AND next_at<=? AND (kind='weekly' OR next_at>=?)`;

export const SCHEDULE_ADMISSION = `EXISTS(WITH pending AS (${SCHEDULE_PENDING})
 SELECT 1 FROM (SELECT kind,next_at FROM pending ORDER BY ${SCHEDULE_PRIORITY} LIMIT 1)
 WHERE kind=? AND next_at=?)`;
