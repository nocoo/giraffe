import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession } from "./session";

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
	await ensureSession();
	try {
		return await apiGet<AlertsSnapshot>("alerts");
	} catch (err) {
		if (err instanceof ApiError && err.code === "snapshot_missing") {
			return { missing: true };
		}
		throw err;
	}
}
