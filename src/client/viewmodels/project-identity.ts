import { type ProjectIdentity, projectKey } from "../../lib/project-identity";
import { apiGet } from "../lib/api";

const cache = new Map<string, { project: ProjectIdentity; expires: number }>();
const pending = new Map<string, Promise<ProjectIdentity | null>>();

export function cachedProjectIdentity(repository: string): ProjectIdentity | null {
	const key = projectKey(repository);
	if (!key) return null;
	const entry = cache.get(key);
	if (entry && entry.expires > Date.now()) return entry.project;
	cache.delete(key);
	return null;
}

export async function loadProjectIdentity(repository: string): Promise<ProjectIdentity | null> {
	const key = projectKey(repository);
	if (!key) return null;
	const saved = cachedProjectIdentity(key);
	if (saved) return saved;
	const running = pending.get(key);
	if (running) return running;
	const request = apiGet<ProjectIdentity | null>(`projects/${key}`)
		.then((project) => {
			if (project) cache.set(key, { project, expires: Date.now() + 3_600_000 });
			return project;
		})
		.catch(() => null)
		.finally(() => pending.delete(key));
	pending.set(key, request);
	return request;
}
