import type { SecuritySnapshot } from "../../lib/security";
import type { SnapshotFreshness } from "../../lib/snapshot-freshness";
import { getRepositoryScope, scopedResource } from "./scope";
import { loadKind } from "./snapshot";

export type AlertItem = {
	name_with_owner: string;
	source: string;
	severity: string;
	summary: string;
	url: string;
};

export type AlertsSnapshot = SecuritySnapshot & {
	freshness?: SnapshotFreshness;
	account_id: string;
	fetched_at: string;
	items: AlertItem[];
};

export async function loadAlerts(
	scope = getRepositoryScope(),
): Promise<AlertsSnapshot | { missing: true }> {
	return loadKind<AlertsSnapshot>(scopedResource("alerts", scope));
}
