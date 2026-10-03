export const JEV_MAX_REQUEST_BYTES = 16 * 1024;

export function requestBytes(request: unknown): number {
	return Buffer.byteLength(JSON.stringify(request), "utf8");
}

export function clipText(text: string, limit: number): string {
	const points = Array.from(text);
	return points.length <= limit
		? text
		: `${points.slice(0, limit).join("")} [clipped ${points.length - limit} codepoints]`;
}

export function boundedLimitations(limitations: string[]) {
	return {
		limitations: limitations.slice(0, 4).map((text) => clipText(text, 160)),
		limitationsOmitted: Math.max(0, limitations.length - 4),
	};
}

export function assertRequestFits(request: unknown, lane: string, repository: string): void {
	const bytes = requestBytes(request);
	if (bytes > JEV_MAX_REQUEST_BYTES)
		throw new Error(
			`Jev ${lane} preflight for ${repository}: ${bytes} bytes exceeds ${JEV_MAX_REQUEST_BYTES}; oversized single scope requires manual inspection or narrowing before scheduling.`,
		);
}

export function boundedBatches<Item>(
	items: Item[],
	build: (batch: Item[]) => unknown,
	lane: string,
	identity: (item: Item) => string,
): Item[][] {
	for (const item of items) assertRequestFits(build([item]), lane, identity(item));
	const batches: Item[][] = [];
	let batch: Item[] = [];
	for (const item of items) {
		const next = [...batch, item];
		if (next.length > 25 || requestBytes(build(next)) > JEV_MAX_REQUEST_BYTES) {
			batches.push(batch);
			batch = [item];
		} else batch = next;
	}
	if (batch.length) batches.push(batch);
	return batches;
}
