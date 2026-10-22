import { type ContentMetadata, observationVersion } from "./content-version";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";

function publicationMetadata(encoded: string | null): ContentMetadata & { fullVersion: string } {
	try {
		const metadata = JSON.parse(encoded ?? "null") as ContentMetadata | null;
		const digest = /^sha256:[a-f0-9]{64}$/;
		if (
			metadata &&
			typeof metadata.hash === "string" &&
			digest.test(metadata.hash) &&
			typeof metadata.fullVersion === "string" &&
			digest.test(metadata.fullVersion)
		)
			return { ...metadata, fullVersion: metadata.fullVersion };
	} catch {}
	throw new ApiError(409, "snapshot_metadata_invalid", "Staged snapshot metadata is incomplete");
}

export async function publishSiteSnapshots(db: Db, lease: RunLease, now: string) {
	const rows = await db
		.prepare(
			"SELECT substr(stream,6) AS kind,content_meta FROM factory_resources WHERE run_id=? AND repo='' AND stream LIKE 'site:%' ORDER BY stream",
		)
		.bind(lease.run.id)
		.all<{ kind: string; content_meta: string | null }>();
	const publication = { runId: lease.run.id, publishedAt: now };
	const metadata = new Map<string, string>();
	const staged = new Map<string, string>();
	for (const row of rows.results) {
		const saved = publicationMetadata(row.content_meta);
		if (row.kind.endsWith("#2")) {
			if (staged.get(row.kind.slice(0, -2)) !== row.content_meta)
				throw new ApiError(409, "snapshot_metadata_invalid", "Staged snapshot pages disagree");
			continue;
		}
		staged.set(row.kind, row.content_meta as string);
		metadata.set(
			row.kind,
			JSON.stringify({
				...saved,
				fullVersion: await observationVersion({ snapshot: saved.fullVersion, publication }),
			}),
		);
	}
	const encoded = JSON.stringify(Object.fromEntries(metadata));
	return [
		fenced(
			db,
			lease,
			now,
			"DELETE FROM snapshots WHERE account_id=? AND kind IN (SELECT key FROM json_each(?) UNION ALL SELECT key || '#2' FROM json_each(?)) AND $guard",
			[lease.run.account_id, encoded, encoded],
		),
		fenced(
			db,
			lease,
			now,
			"INSERT INTO snapshots(account_id,kind,payload,fetched_at,content_meta) SELECT ?,substr(staged.stream,6),json_set(staged.payload,'$.publication',json(?)),json_extract(staged.payload,'$.fetched_at'),metadata.value FROM factory_resources staged JOIN json_each(?) metadata ON substr(staged.stream,6) IN (metadata.key,metadata.key || '#2') WHERE staged.run_id=? AND staged.repo='' AND $guard",
			[lease.run.account_id, JSON.stringify(publication), encoded, lease.run.id],
		),
	];
}
