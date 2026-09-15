import type { FactoryStreamData, FactoryStreamName } from "../../src/lib/factory-types";
import type { Env } from "../../src/server/env";
import { newFactory } from "../../src/server/lib/factory-collect";
import { mapFactoryRepo } from "../../src/server/lib/factory-map";
import { createGithubClient } from "../../src/server/lib/github-client";

export const NOW = "2026-09-15T22:00:00.000Z";
export const rawRepo = {
	id: "R_1",
	nameWithOwner: "nocoo/app",
	owner: { login: "nocoo" },
	url: "https://github.com/nocoo/app",
	description: "Example",
	isPrivate: true,
	diskUsage: 1024,
	pushedAt: NOW,
	primaryLanguage: { name: "TypeScript" },
	languages: {
		totalSize: 100,
		totalCount: 1,
		edges: [{ size: 100, node: { name: "TypeScript" } }],
	},
	repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
	defaultBranchRef: { name: "main", target: { oid: "abc", history: { totalCount: 3 } } },
	openIssues: { totalCount: 1 },
	closedIssues: { totalCount: 2 },
	openPrs: { totalCount: 1 },
	closedPrs: { totalCount: 2 },
	mergedPrs: { totalCount: 3 },
	releases: { totalCount: 1 },
};
export function ready(stream: FactoryStreamName = "commits") {
	const state = newFactory("account_123", "nocoo", NOW);
	state.inventory.complete = true;
	state.contributionStatus = "complete";
	state.repos = [mapFactoryRepo(rawRepo)];
	state.cursor.stream = [
		"commits",
		"issues",
		"prs",
		"actions",
		"releases",
		"alerts",
		"dependencies",
	].indexOf(stream);
	return state;
}
export function memoryStore() {
	const data = new Map<string, FactoryStreamData>();
	return {
		data,
		read: async (key: string) => structuredClone(data.get(key) ?? null),
		write: async (key: string, item: FactoryStreamData) => {
			data.set(key, structuredClone(item));
		},
	};
}
export function github(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	return createGithubClient({ ENVIRONMENT: "production" } as Env, (url, init) =>
		Promise.resolve(handler(String(url), init)),
	);
}
export function rawEvent(id = 1) {
	return {
		id,
		number: id,
		node_id: `N_${id}`,
		html_url: `https://github.com/nocoo/app/issues/${id}`,
		title: "Work",
		created_at: "2026-09-01T00:00:00Z",
		closed_at: null,
		merged_at: null,
		user: { login: "nocoo" },
		state: "open",
	};
}
