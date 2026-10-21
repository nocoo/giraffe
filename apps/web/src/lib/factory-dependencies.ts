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

export function dependencyEvidence(items: FactoryEvent[], saved: FactoryDependency[] = []) {
	const manifests = manifestsFrom(items.map(dependencyFromEvent), saved);
	const names = new Set(manifests.map((manifest) => manifest.name));
	return {
		manifests,
		items: items
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
