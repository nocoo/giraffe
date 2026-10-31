import * as warmRun from "./dashboard-warm-run";
import type { Db } from "./db/d1";
import type { AccountObservationResource } from "./saved-observation-statements";
import type { SnapshotScope } from "./snapshot-scope";

export const warmDashboardResponsesAfterPublish = warmRun.warmDashboardResponsesAfterPublish;

export async function warmDashboardResponsesAfterPublishSafely(
	db: Db,
	accountId: string,
): Promise<void> {
	try {
		await warmRun.warmDashboardResponsesAfterPublish(db, accountId);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`dashboard warm after publish failed for ${accountId}: ${detail}`);
	}
}

export async function warmDashboardResource(
	db: Db,
	accountId: string,
	_resource: AccountObservationResource,
	_scope: SnapshotScope,
): Promise<void> {
	await warmDashboardResponsesAfterPublishSafely(db, accountId);
}
