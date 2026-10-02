export type RepositoryScope = "starred" | "all";

let scope: RepositoryScope = "starred";
const listeners = new Set<() => void>();

export const getRepositoryScope = (): RepositoryScope => scope;

export function setRepositoryScope(next: RepositoryScope): void {
	if (scope === next) return;
	scope = next;
	for (const listener of listeners) listener();
}

export function subscribeRepositoryScope(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function scopedResource(resource: string, selected = getRepositoryScope()): string {
	const [path, query] = resource.split("?");
	const params = new URLSearchParams(query);
	params.set("scope", selected);
	return `${path}?${params}`;
}
