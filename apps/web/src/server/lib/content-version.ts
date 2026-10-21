function omit(value: unknown, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries((value ?? {}) as Record<string, unknown>).filter(([key]) => !keys.includes(key)),
	);
}

function coverage(value: unknown) {
	return omit(value, ["fetchedAt", "sourceFetchedAt", "pages", "strategy"]);
}

function contribution(value: unknown) {
	if (!value) return value;
	const data = omit(value, ["fetchedAt", "observedAt"]);
	if (Array.isArray(data.days)) data.days = data.days.map((day) => omit(day, ["observedAt"]));
	return data;
}

export function contentData(resource: string, value: Record<string, unknown>) {
	const data = omit(value, ["fetched_at", "repository_fetched_at"]);
	if (data.freshness && typeof data.freshness === "object")
		data.freshness = omit(data.freshness, ["oldestAt", "latestAt"]);
	if (resource === "factory" || resource.startsWith("factory:")) {
		for (const key of [
			"runId",
			"revision",
			"leaseUntil",
			"startedAt",
			"requests",
			"rate",
			"rateLimits",
			"cursor",
			"publication",
			"next",
		])
			delete data[key];
		if (data.coverage) data.coverage = coverage(data.coverage);
		if (data.observation)
			data.observation = omit(data.observation, [
				"version",
				"refreshedAt",
				"metadataAt",
				"source",
				"repo",
			]);
		if (data.inventory) data.inventory = omit(data.inventory, ["pages", "after"]);
		if (Array.isArray(data.repos))
			data.repos = data.repos.map((value) => {
				const repo = omit(value, ["metadataAt"]);
				if (repo.observation)
					repo.observation = omit(repo.observation, [
						"version",
						"refreshedAt",
						"metadataAt",
						"source",
						"repo",
					]);
				repo.coverage = Object.fromEntries(
					Object.entries(repo.coverage as Record<string, unknown>).map(([stream, value]) => [
						stream,
						coverage(value),
					]),
				);
				return repo;
			});
		if (data.contribution) data.contribution = contribution(data.contribution);
		if (data.contributionObservation)
			data.contributionObservation = omit(data.contributionObservation, ["version", "fetchedAt"]);
	}
	if (resource === "contributions") {
		delete data.observedAt;
		if (Array.isArray(data.days)) data.days = data.days.map((day) => omit(day, ["observedAt"]));
	}
	return data;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export async function contentVersion(resource: string, data: Record<string, unknown>) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical(contentData(resource, data))),
	);
	return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
