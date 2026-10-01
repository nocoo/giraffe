import type { SnapshotFreshness } from "../../lib/snapshot-freshness";
import { apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { getRepositoryScope, scopedResource } from "./scope";
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
	freshness?: SnapshotFreshness;
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

export async function loadInbox(
	scope = getRepositoryScope(),
): Promise<NotificationsSnapshot | { missing: true }> {
	return loadKind<NotificationsSnapshot>(scopedResource("notifications", scope));
}

export async function markRead(
	id: string,
	account_id: string,
	scope = getRepositoryScope(),
): Promise<NotificationsSnapshot> {
	try {
		const body = await apiPost<NotificationsSnapshot>(scopedResource("notifications/read", scope), {
			id,
			account_id,
		});
		return body;
	} catch (err) {
		if (err instanceof ApiError && err.code === "account_conflict") {
			await ensureSession();
		}
		throw err;
	}
}

export async function markReadAll(
	account_id: string,
	scope = getRepositoryScope(),
): Promise<NotificationsSnapshot> {
	try {
		const body = await apiPost<NotificationsSnapshot>(
			scopedResource("notifications/read-all", scope),
			{ account_id },
		);
		return body;
	} catch (err) {
		if (err instanceof ApiError && err.code === "account_conflict") {
			await ensureSession();
		}
		throw err;
	}
}
