import { loadKind } from "./snapshot";

export type AlertItem = {
	name_with_owner: string;
	source: string;
	severity: string;
	summary: string;
	url: string;
};

export type AlertsSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	unavailable: boolean;
	dependabot_open: number;
	code_scanning_open: number;
	items: AlertItem[];
};

export function alertsUnavailable(snap: AlertsSnapshot): boolean {
	return snap.unavailable === true;
}

export function visibleAlerts(snap: AlertsSnapshot): AlertItem[] {
	if (alertsUnavailable(snap)) {
		return [];
	}
	return snap.items;
}

export async function loadAlerts(): Promise<AlertsSnapshot | { missing: true }> {
	return loadKind<AlertsSnapshot>("alerts");
}
