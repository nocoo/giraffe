const MAX = 1_500_000;

export type SnapshotPage = { kind: string; payload: string };

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
	return JSON.stringify({ ...base, [key]: items, truncated });
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

export function splitPages(
	logical: string,
	payload: Record<string, unknown>,
): {
	pages: SnapshotPage[];
	truncated: boolean;
} {
	const encoded = JSON.stringify(payload);
	if (utf8Len(encoded) <= MAX) {
		return { pages: [{ kind: logical, payload: encoded }], truncated: payload.truncated === true };
	}
	const key = arrayKey(payload);
	if (!key || !Array.isArray(payload[key])) {
		return {
			pages: [{ kind: logical, payload: JSON.stringify({ ...payload, truncated: true }) }],
			truncated: true,
		};
	}
	const items = payload[key] as unknown[];
	let truncated = payload.truncated === true;
	const pageItems: unknown[][] = [[], []];
	let page = 0;
	for (const item of items) {
		if (!fitsPage(payload, key, [], item, true)) {
			truncated = true;
			continue;
		}
		const slot = pageItems[page] as unknown[];
		if (fitsPage(payload, key, slot, item, true)) {
			slot.push(item);
			continue;
		}
		if (page === 0) {
			page = 1;
			const second = pageItems[1] as unknown[];
			if (fitsPage(payload, key, second, item, true)) {
				second.push(item);
				continue;
			}
		}
		truncated = true;
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
	return { pages, truncated };
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
		return head;
	}
	const tail = JSON.parse(second.payload) as Record<string, unknown>;
	const a = head[key] as unknown[];
	const b = Array.isArray(tail[key]) ? (tail[key] as unknown[]) : [];
	return { ...head, [key]: [...a, ...b] };
}

export function physicalKinds(logical: string): [string, string] {
	return [logical, `${logical}#2`];
}
