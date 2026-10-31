import {
	buildBrowserAccountSnapshot,
	buildBrowserActivity,
	buildBrowserCi,
	buildBrowserFactory,
	buildMachineAccountObservation,
} from "./dashboard-builders";
import { accountObservationDataVersion, activityDataVersion } from "./dashboard-data-version";
import {
	dashboardCacheKey,
	pruneWarmRows,
	storeWarmDashboardBody,
} from "./dashboard-response-cache";
import type { Db } from "./db/d1";
import type { SnapshotScope } from "./snapshot-scope";

const SCOPES: SnapshotScope[] = ["starred", "all"];

export async function warmDashboardResponsesAfterPublish(db: Db, accountId: string): Promise<void> {
	const keys: string[] = [];
	for (const scope of SCOPES) {
		const scopeKey = { scope };
		for (const resource of ["factory", "ci", "repos", "issues", "prs"] as const) {
			const cacheKey = dashboardCacheKey(`browser:/api/${resource}`, scopeKey);
			keys.push(cacheKey);
			const version = await accountObservationDataVersion(db, accountId, resource, scope, false);
			try {
				if (resource === "factory") {
					const built = await buildBrowserFactory(db, scope);
					await storeWarmDashboardBody(db, accountId, cacheKey, version, built.stored);
					continue;
				}
				if (resource === "ci") {
					const built = await buildBrowserCi(db, scope);
					await storeWarmDashboardBody(db, accountId, cacheKey, version, built.stored);
					continue;
				}
				const built = await buildBrowserAccountSnapshot(db, resource, scope, false);
				await storeWarmDashboardBody(db, accountId, cacheKey, version, built.stored);
			} catch {
				// Skip routes that are not yet readable for this account.
			}
			const machineKey = dashboardCacheKey(`machine:/accounts/${resource}`, scopeKey);
			keys.push(machineKey);
			const machineVersion = await accountObservationDataVersion(
				db,
				accountId,
				resource,
				scope,
				false,
			);
			try {
				const built = await buildMachineAccountObservation(db, accountId, resource, scope, false);
				await storeWarmDashboardBody(db, accountId, machineKey, machineVersion, built.stored);
			} catch {
				// Skip unreadable machine observations during partial publish.
			}
		}
	}
	const activityKey = dashboardCacheKey("browser:/api/activity", {});
	keys.push(activityKey);
	const activityVersion = await activityDataVersion(db, accountId, "");
	try {
		const built = await buildBrowserActivity(db, accountId, {});
		await storeWarmDashboardBody(db, accountId, activityKey, activityVersion, built.stored);
	} catch {
		// Activity may remain unavailable until a compatible publication exists.
	}
	const machineActivityKey = dashboardCacheKey("machine:/accounts/activity", {});
	keys.push(machineActivityKey);
	try {
		const built = await buildBrowserActivity(db, accountId, {});
		await storeWarmDashboardBody(db, accountId, machineActivityKey, activityVersion, built.stored);
	} catch {
		// Same as browser activity warm-up.
	}
	await pruneWarmRows(db, accountId, keys);
}
