import { object } from "../../apps/web/src/server/lib/refresh-collection/model";

const viewerOf = (entry: unknown) =>
	entry && typeof entry === "object" && "viewer" in entry
		? object((entry as Record<string, unknown>).viewer)
		: null;

export const isAccountFixture = (entry: unknown): boolean => {
	if (entry instanceof Error) return true;
	if (entry instanceof Response) return false;
	const viewer = viewerOf(entry);
	if (!viewer) return false;
	const repositories = object(viewer.repositories);
	return Array.isArray(repositories.nodes) || repositories.totalCount !== undefined;
};

export const isRepositoryFixture = async (entry: unknown): Promise<boolean> => {
	if (entry instanceof Error) return true;
	if (entry && typeof entry === "object" && "node" in entry) return true;
	if (entry instanceof Response) {
		const payload = (await entry
			.clone()
			.json()
			.catch(() => null)) as {
			data?: { node?: unknown };
			errors?: { path?: unknown[] }[];
		} | null;
		if (payload?.data?.node) return true;
		if (payload?.errors?.some((error) => error.path?.[0] === "node")) return true;
	}
	return false;
};

export const isCalendarFixture = async (entry: unknown): Promise<boolean> => {
	const viewer = viewerOf(entry);
	if (viewer) {
		if (isAccountFixture(entry)) return false;
		return (
			object(viewer.contributionsCollection).contributionCalendar !== undefined ||
			Object.keys(viewer).length <= 1
		);
	}
	if (entry instanceof Response) {
		const payload = (await entry
			.clone()
			.json()
			.catch(() => null)) as {
			data?: { node?: unknown; viewer?: { contributionsCollection?: unknown } };
			errors?: { path?: unknown[] }[];
		} | null;
		if (payload?.data?.node) return false;
		if (payload?.errors?.some((error) => error.path?.[0] === "node")) return false;
		if (payload?.data?.viewer?.contributionsCollection) return true;
		if (
			payload?.errors?.some(
				(error) =>
					error.path?.includes("contributionsCollection") ||
					error.path?.includes("contributionCalendar"),
			)
		)
			return true;
		if (payload?.data === null && payload?.errors?.length) return true;
	}
	return false;
};

export async function takeQueueEntry(
	queue: unknown[],
	match: (entry: unknown) => boolean | Promise<boolean>,
): Promise<unknown | undefined> {
	for (let index = 0; index < queue.length; index += 1) {
		if (await match(queue[index])) return queue.splice(index, 1)[0];
	}
	return undefined;
}
