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

export type AlertsSnapshot = {
	freshness?: SnapshotFreshness;
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	unavailable: boolean;
	dependabot_open: number;
	code_scanning_open: number;
	items: AlertItem[];
};

export async function loadAlerts(
	scope = getRepositoryScope(),
): Promise<AlertsSnapshot | { missing: true }> {
	return loadKind<AlertsSnapshot>(scopedResource("alerts", scope));
}
