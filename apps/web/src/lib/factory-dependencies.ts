import type { FactoryDependency, FactoryEvent, FactoryRepo } from "./factory-types";

function isIdentity(path: string) {
	return /(?:^|\/)package\.json#name$/.test(path);
}

function isSelfPackage(path: string, name: string, names: Set<string>) {
	return (
		/(?:^|\/)package\.json#(?:dependencies|devDependencies|peerDependencies|optionalDependencies)$/.test(
			path,
		) && names.has(name)
	);
}

function manifestsFrom(dependencies: FactoryDependency[], saved: FactoryDependency[]) {
	const manifests = [
		...saved,
		...dependencies
			.filter((dependency) => isIdentity(dependency.path))
			.map((dependency) => ({ ...dependency, path: dependency.path.slice(0, -5) })),
	];
	return [
		...new Map(
			manifests.map((manifest) => [`${manifest.path}:${manifest.name}`, manifest]),
		).values(),
	];
}

export function dependencyFromEvent(event: FactoryEvent): FactoryDependency {
	return {
		name: event.title,
		version: event.version ?? "",
		path: event.path ?? "",
		url: event.url,
	};
}

export function uniqueDependencySummaries(dependencies: FactoryDependency[]) {
	const seen = new Set<string>();
	return dependencies.filter(({ path, name, version, url }) => {
		const key = JSON.stringify([path, name, version, url]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort()
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}

function uniqueWorkflowItems(items: FactoryEvent[]) {
	const groups = new Map<string, Map<string, FactoryEvent>>();
	const key = (item: FactoryEvent) =>
		JSON.stringify(
			canonical(Object.fromEntries(Object.entries(item).filter(([name]) => name !== "id"))),
		);
	const base = (item: FactoryEvent) =>
		`${item.path}:${item.title}${item.job ? `#job=${encodeURIComponent(item.job)}` : ""}`;
	for (const item of items) {
		if (!/^\.github\/workflows\/[^#]+\.ya?ml$/.test(item.path ?? "")) continue;
		const group = groups.get(base(item)) ?? new Map<string, FactoryEvent>();
		group.set(key(item), item);
		groups.set(base(item), group);
	}
	const seen = new Set<string>();
	return items.flatMap((item) => {
		const group = groups.get(base(item));
		if (!group) return [item];
		const identity = key(item);
		if (seen.has(identity)) return [];
		seen.add(identity);
		let id = item.job || group.size > 1 ? base(item) : item.id;
		if (group.size > 1) {
			id += `${item.job ? "&" : "#"}ref=${encodeURIComponent(item.version ?? "")}`;
			const sameRef = [...group.values()]
				.filter((other) => (other.version ?? "") === (item.version ?? ""))
				.map(key)
				.sort();
			if (sameRef.length > 1) id += `&entry=${sameRef.indexOf(identity) + 1}`;
		}
		return [{ ...item, id }];
	});
}

export function dependencyEvidence(items: FactoryEvent[], saved: FactoryDependency[] = []) {
	const manifests = manifestsFrom(items.map(dependencyFromEvent), saved);
	const names = new Set(manifests.map((manifest) => manifest.name));
	return {
		manifests,
		items: uniqueWorkflowItems(
			items
				.filter(
					(item) =>
						!isIdentity(item.path ?? "") && !isSelfPackage(item.path ?? "", item.title, names),
				)
				.map((item) => ({
					...item,
					at: item.at || null,
					createdAt: item.createdAt || null,
					author: item.author || null,
				})),
		),
	};
}

export function normalizeRepoDependencies(repo: FactoryRepo): FactoryRepo {
	const manifests = manifestsFrom(repo.dependencies, repo.manifests ?? []);
	const names = new Set(manifests.map((manifest) => manifest.name));
	return {
		...repo,
		...(manifests.length ? { manifests } : {}),
		dependencies: repo.dependencies.filter(
			(dependency) =>
				!isIdentity(dependency.path) && !isSelfPackage(dependency.path, dependency.name, names),
		),
	};
}
