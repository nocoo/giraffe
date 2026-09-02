import { apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession } from "./session";
import { loadKind } from "./snapshot";

export type NotificationRow = {
	id: string;
	unread: boolean;
	reason: string;
	updated_at: string;
	title: string;
	url: string;
	name_with_owner: string;
};

export type NotificationsSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	notifications: NotificationRow[];
};

export function applyRead(snap: NotificationsSnapshot, id: string): NotificationsSnapshot {
	return {
		...snap,
		notifications: snap.notifications.map((row) =>
			row.id === id ? { ...row, unread: false } : row,
		),
	};
}

export function applyReadAll(snap: NotificationsSnapshot): NotificationsSnapshot {
	return {
		...snap,
		notifications: snap.notifications.map((row) => ({ ...row, unread: false })),
	};
}

export async function loadInbox(): Promise<NotificationsSnapshot | { missing: true }> {
	return loadKind<NotificationsSnapshot>("notifications");
}

export async function markRead(id: string, account_id: string): Promise<NotificationsSnapshot> {
	try {
		return await apiPost<NotificationsSnapshot>("notifications/read", { id, account_id });
	} catch (err) {
		if (err instanceof ApiError && err.code === "account_conflict") {
			await ensureSession();
		}
		throw err;
	}
}

export async function markReadAll(account_id: string): Promise<NotificationsSnapshot> {
	try {
		return await apiPost<NotificationsSnapshot>("notifications/read-all", { account_id });
	} catch (err) {
		if (err instanceof ApiError && err.code === "account_conflict") {
			await ensureSession();
		}
		throw err;
	}
}
