import type { Db } from "./db/d1";
import { ApiError } from "./errors";
export const FACTORY_STORAGE_LIMIT = 256_000_000;
export async function factoryStorage(db: Db, account: string) {
	const row = await db
		.prepare("SELECT bytes FROM factory_storage WHERE account_id=?")
		.bind(account)
		.first<{ bytes: number }>();
	const total = await db
		.prepare("SELECT bytes FROM factory_budget WHERE account_id=?")
		.bind(account)
		.first<{ bytes: number }>();
	// Existing triggers count factory rows; ordinary pages and daily baselines share the quota.
	const pages = await db
		.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes FROM (
		SELECT length(CAST(payload AS BLOB)) AS bytes FROM snapshots WHERE account_id=? AND kind NOT LIKE 'factory%'
		UNION ALL SELECT length(CAST(payload AS BLOB)) FROM snapshot_days WHERE account_id=?
		UNION ALL SELECT length(CAST(COALESCE(input,'')||COALESCE(judgment,'')||COALESCE(report,'') AS BLOB)) FROM ai_reviews WHERE account_id=?
	)`)
		.bind(account, account, account)
		.first<{ bytes: number }>();
	return {
		resourceBytes: row?.bytes ?? 0,
		totalBytes: (total?.bytes ?? 0) + (pages?.bytes ?? 0),
		limitBytes: FACTORY_STORAGE_LIMIT,
	};
}
export async function checkFactoryCapacity(db: Db, account: string, delta: number) {
	const storage = await factoryStorage(db, account);
	if (storage.totalBytes + Math.max(0, delta) > FACTORY_STORAGE_LIMIT - 2_000_000)
		throw new ApiError(
			422,
			"factory_capacity",
			"factory data budget reached; 2 MB reserved for controls",
		);
}
export async function resourceDelta(
	db: Db,
	run: string,
	repo: string,
	stream: string,
	payload: string,
) {
	const old = await db
		.prepare(
			"SELECT length(CAST(payload AS BLOB)) AS bytes FROM factory_resources WHERE run_id=? AND repo=? AND stream=?",
		)
		.bind(run, repo, stream)
		.first<{ bytes: number }>();
	return new TextEncoder().encode(payload).length - (old?.bytes ?? 0);
}
/** Bounded GC. Current heads, their manifests, two latest publications and 20 recent runs are roots. */
export async function pruneFactory(db: Db, now: string) {
	const cutoff = new Date(Date.parse(now) - 7 * 86400_000).toISOString();
	await db.batch([
		db
			.prepare(`DELETE FROM snapshots WHERE (account_id,kind) IN (
   SELECT s.account_id,s.kind FROM snapshots s WHERE (s.kind LIKE 'factory:v:%' OR s.kind LIKE 'factory:catalog:%') AND s.fetched_at<?
   AND NOT EXISTS(SELECT 1 FROM factory_state h WHERE h.account_id=s.account_id AND (s.kind IN ('factory:v:'||h.published_id,'factory:v:'||h.published_id||'#2','factory:catalog:'||h.catalog_id,'factory:catalog:'||h.catalog_id||'#2')))
   AND NOT EXISTS(SELECT 1 FROM (SELECT id FROM factory_runs r WHERE r.account_id=s.account_id ORDER BY created_at DESC LIMIT 20) recent WHERE s.kind IN ('factory:v:'||recent.id,'factory:v:'||recent.id||'#2','factory:catalog:'||recent.id,'factory:catalog:'||recent.id||'#2'))
   AND NOT EXISTS(SELECT 1 FROM (SELECT kind FROM snapshots p WHERE p.account_id=s.account_id AND p.kind LIKE 'factory:v:%' AND instr(p.kind,'#')=0 ORDER BY fetched_at DESC LIMIT 2) latest WHERE s.kind IN (latest.kind,latest.kind||'#2')) LIMIT 50)`)
			.bind(cutoff),
		db.prepare(
			"DELETE FROM factory_version_refs WHERE (account_id,publication_id,repo) IN (SELECT f.account_id,f.publication_id,f.repo FROM factory_version_refs f WHERE NOT EXISTS(SELECT 1 FROM snapshots s WHERE s.account_id=f.account_id AND s.kind='factory:v:'||f.publication_id) LIMIT 100)",
		),
		db
			.prepare(`DELETE FROM factory_repo_versions WHERE (account_id,repo,version) IN (SELECT v.account_id,v.repo,v.version FROM factory_repo_versions v WHERE v.refreshed_at<?
   AND NOT EXISTS(SELECT 1 FROM factory_repo_state s WHERE s.account_id=v.account_id AND s.repo=v.repo AND s.version=v.version)
   AND NOT EXISTS(SELECT 1 FROM factory_version_refs f WHERE f.account_id=v.account_id AND f.repo=v.repo AND f.version=v.version)
   AND v.version NOT IN(SELECT id FROM factory_runs r WHERE r.account_id=v.account_id ORDER BY created_at DESC LIMIT 20) LIMIT 50)`)
			.bind(cutoff),
		db
			.prepare(`DELETE FROM factory_resources WHERE (run_id,repo,stream) IN (SELECT s.run_id,s.repo,s.stream FROM factory_resources s JOIN factory_runs r ON r.id=s.run_id WHERE r.status NOT IN ('running','paused') AND r.created_at<?
   AND r.id NOT IN(SELECT id FROM factory_runs recent WHERE recent.account_id=r.account_id ORDER BY created_at DESC LIMIT 20)
   AND NOT EXISTS(SELECT 1 FROM factory_repo_state h WHERE h.account_id=r.account_id AND h.repo=s.repo AND h.version=s.run_id)
   AND NOT EXISTS(SELECT 1 FROM factory_version_refs f WHERE f.account_id=r.account_id AND f.repo=s.repo AND f.version=s.run_id AND f.source='run') LIMIT 50)`)
			.bind(cutoff),
		db
			.prepare(`DELETE FROM factory_runs WHERE id IN (SELECT r.id FROM factory_runs r WHERE r.status NOT IN ('running','paused') AND r.created_at<?
   AND r.id NOT IN(SELECT id FROM factory_runs recent WHERE recent.account_id=r.account_id ORDER BY created_at DESC LIMIT 20)
   AND NOT EXISTS(SELECT 1 FROM factory_resources s WHERE s.run_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM factory_repo_versions v WHERE v.account_id=r.account_id AND v.version=r.id)
   AND NOT EXISTS(SELECT 1 FROM factory_version_refs f WHERE f.account_id=r.account_id AND (f.version=r.id OR f.publication_id=r.id))
   AND NOT EXISTS(SELECT 1 FROM snapshots s WHERE s.account_id=r.account_id AND s.kind IN ('factory:v:'||r.id,'factory:catalog:'||r.id)) LIMIT 50)`)
			.bind(cutoff),
	]);
}
