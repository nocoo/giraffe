import type { ActivityCommit } from "../../lib/activity-types";
import type { Db } from "./db/d1";
import { fencedPostcondition, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import { FACTORY_STORAGE_SQL } from "./factory-retention";

const currentStorage = `ledger AS (
 SELECT COUNT(*) AS identities,COALESCE(SUM(length(CAST(account_id||repo_id||sha||first_run_id||observed_at||window_since||window_until||COALESCE(payload,'')||COALESCE(published_run_id,'')||reconciliation AS BLOB))),0) AS bytes
 FROM activity_commit_ledger WHERE account_id=(SELECT account FROM args)),
 heads AS (SELECT COALESCE(SUM(length(CAST(account_id||repo_id||COALESCE(head,'')||COALESCE(pending,'') AS BLOB))),0) AS bytes FROM activity_commit_heads WHERE account_id=(SELECT account FROM args)),
 storage AS (${FACTORY_STORAGE_SQL.replaceAll("?", "(SELECT account FROM args)")})`;

export async function landedQuota(
	db: Db,
	lease: RunLease,
	repo: string,
	items: ActivityCommit[],
	head: string | null,
	pending: string | null,
	now: string,
	reconciliation = "",
) {
	const sql = `WITH args AS (SELECT ? AS account,? AS repo,? AS items,? AS head,? AS pending,? AS reconciliation),
	 ${currentStorage},
	 candidates AS (SELECT value FROM args,json_each(args.items) WHERE NOT EXISTS(SELECT 1 FROM activity_commit_ledger WHERE account_id=args.account AND repo_id=args.repo AND sha=json_extract(value,'$.sha'))),
	 added AS (SELECT
	 (SELECT COALESCE(SUM(length(CAST(args.account||args.repo||json_extract(value,'$.sha')||json_extract(value,'$.observation.runId')||json_extract(value,'$.observation.at')||json_extract(value,'$.observation.window.since')||json_extract(value,'$.observation.window.until')||value||args.reconciliation AS BLOB))),0) FROM candidates,args)
	 +(SELECT COALESCE(SUM(length(CAST(args.reconciliation AS BLOB))-length(CAST(existing.reconciliation AS BLOB))),0) FROM args,json_each(args.items) JOIN activity_commit_ledger existing ON existing.account_id=args.account AND existing.repo_id=args.repo AND existing.sha=json_extract(value,'$.sha'))
	 +(SELECT length(CAST(account||repo||COALESCE(head,'')||COALESCE(pending,'') AS BLOB)) FROM args)
	 -COALESCE((SELECT length(CAST(account_id||repo_id||COALESCE(head,'')||COALESCE(pending,'') AS BLOB)) FROM activity_commit_heads WHERE account_id=(SELECT account FROM args) AND repo_id=(SELECT repo FROM args)),0) AS bytes)
	 SELECT ledger.identities+(SELECT COUNT(*) FROM candidates)<=100000 AND ledger.bytes+heads.bytes+added.bytes<=64000000 AND storage.totalBytes+added.bytes<=512000000 AS allowed FROM ledger,heads,added,storage`;
	const values = [lease.run.account_id, repo, JSON.stringify(items), head, pending, reconciliation];
	if (
		!(
			await db
				.prepare(sql)
				.bind(...values)
				.first<{ allowed: number }>()
		)?.allowed
	)
		throw new ApiError(
			422,
			"factory_capacity",
			"Default commit ledger capacity reached; identities and checkpoint retained",
		);
	return fencedPostcondition(
		db,
		lease,
		now,
		`WITH args AS (SELECT ? AS account),${currentStorage}
		 SELECT CASE WHEN ledger.identities<=100000 AND ledger.bytes+heads.bytes<=64000000 AND storage.totalBytes<=512000000 THEN 1 ELSE json('{') END FROM ledger,heads,storage`,
		[lease.run.account_id],
	);
}
