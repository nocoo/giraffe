import { securitySnapshot } from "../../lib/security";
import { emptyCollected } from "./collect";
import { decodeContent, withContent } from "./content-version";
import { ApiError } from "./errors";

const MAX = 1_500_000;

export type SnapshotPage = { kind: string; payload: string; content_meta?: string | null };
export type SnapshotGroups = Map<string, Record<string, unknown>>;

export function assembleSnapshotGroups(rows: SnapshotPage[]): SnapshotGroups {
	const groups = new Map<string, SnapshotPage[]>();
	for (const row of rows) {
		const resource = row.kind.replace(/#2$/, "");
		groups.set(resource, [...(groups.get(resource) ?? []), row]);
	}
	return new Map(
		[...groups].flatMap(([resource, pages]) =>
			pages.some((page) => page.kind === resource)
				? [[resource, assemblePages(resource, pages)] as const]
				: [],
		),
	);
}

export function latestSnapshots(groups: SnapshotGroups) {
	const latest = new Map<string, { resource: string; data: Record<string, unknown> }>();
	const time = (data: Record<string, unknown>) => {
		const parsed = typeof data.fetched_at === "string" ? Date.parse(data.fetched_at) : NaN;
		return Number.isFinite(parsed) ? parsed : -Infinity;
	};
	for (const [resource, data] of groups) {
		const key = resource.toLowerCase();
		const previous = latest.get(key);
		if (
			!previous ||
			time(data) > time(previous.data) ||
			(time(data) === time(previous.data) && resource < previous.resource)
		)
			latest.set(key, { resource, data });
	}
	return latest;
}

export function latestSnapshotGroups(rows: SnapshotPage[]) {
	return latestSnapshots(assembleSnapshotGroups(rows));
}

function utf8Len(text: string): number {
	return new TextEncoder().encode(text).length;
}

function arrayKey(payload: Record<string, unknown>): string | undefined {
	for (const [key, value] of Object.entries(payload)) {
		if (Array.isArray(value)) {
			return key;
		}
	}
	return undefined;
}

function pageJson(
	base: Record<string, unknown>,
	key: string,
	items: unknown[],
	truncated: boolean,
): string {
	return JSON.stringify(securitySnapshot({ ...base, [key]: items, truncated }));
}

function fitsPage(
	base: Record<string, unknown>,
	key: string,
	items: unknown[],
	next: unknown,
	truncated: boolean,
): boolean {
	return utf8Len(pageJson(base, key, [...items, next], truncated)) <= MAX;
}

function compactPage(logical: string, payload: Record<string, unknown>): SnapshotPage {
	const compact = JSON.stringify(emptyCollected(logical, String(payload.fetched_at ?? "")));
	if (utf8Len(compact) > MAX)
		throw new ApiError(422, "snapshot_capacity", "snapshot metadata exceeds page capacity");
	return { kind: logical, payload: compact };
}

export function splitPages(
	logical: string,
	payload: Record<string, unknown>,
): {
	pages: SnapshotPage[];
	truncated: boolean;
	capacityExceeded: boolean;
} {
	payload = securitySnapshot(payload);
	const encoded = JSON.stringify(payload);
	if (utf8Len(encoded) <= MAX) {
		return {
			pages: [{ kind: logical, payload: encoded }],
			truncated: payload.truncated === true,
			capacityExceeded: false,
		};
	}
	const key = arrayKey(payload);
	if (!key || !Array.isArray(payload[key]) || utf8Len(pageJson(payload, key, [], true)) > MAX) {
		return {
			pages: [compactPage(logical, payload)],
			truncated: true,
			capacityExceeded: true,
		};
	}
	const items = payload[key] as unknown[];
	let truncated = payload.truncated === true;
	let capacityExceeded = false;
	const pageItems: unknown[][] = [[], []];
	let page = 0;
	for (const item of items) {
		if (!fitsPage(payload, key, [], item, truncated)) {
			truncated = true;
			capacityExceeded = true;
			continue;
		}
		const slot = pageItems[page] as unknown[];
		if (fitsPage(payload, key, slot, item, truncated)) {
			slot.push(item);
			continue;
		}
		if (page === 0) {
			page = 1;
			const second = pageItems[1] as unknown[];
			if (fitsPage(payload, key, second, item, truncated)) {
				second.push(item);
				continue;
			}
		}
		truncated = true;
		capacityExceeded = true;
		break;
	}
	const pages: SnapshotPage[] = [];
	for (let i = 0; i < pageItems.length; i += 1) {
		const slot = pageItems[i];
		if (!slot || (slot.length === 0 && i > 0)) {
			continue;
		}
		if (i === 0 && slot.length === 0) {
			continue;
		}
		const kind = i === 0 ? logical : `${logical}#${i + 1}`;
		pages.push({ kind, payload: pageJson(payload, key, slot, truncated) });
	}
	if (pages.length === 0) {
		pages.push({
			kind: logical,
			payload: pageJson(payload, key, [], true),
		});
		truncated = true;
	}
	return { pages, truncated, capacityExceeded };
}

export function assemblePages(logical: string, rows: SnapshotPage[]): Record<string, unknown> {
	const first = rows.find((row) => row.kind === logical);
	const second = rows.find((row) => row.kind === `${logical}#2`);
	if (!first) {
		return { fetched_at: "", truncated: false };
	}
	const head = JSON.parse(first.payload) as Record<string, unknown>;
	const key = arrayKey(head);
	if (!key || !second) {
		return withContent(securitySnapshot(head), decodeContent(first.content_meta));
	}
	const tail = JSON.parse(second.payload) as Record<string, unknown>;
	const a = head[key] as unknown[];
	const b = Array.isArray(tail[key]) ? (tail[key] as unknown[]) : [];
	return withContent(
		securitySnapshot({ ...head, [key]: [...a, ...b] }),
		first.content_meta === second.content_meta ? decodeContent(first.content_meta) : null,
	);
}

export function physicalKinds(logical: string): [string, string] {
	return [logical, `${logical}#2`];
}
