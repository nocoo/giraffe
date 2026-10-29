import type { FactoryStreamName } from "../../apps/web/src/lib/factory-types";
import type { Env } from "../../apps/web/src/server/env";
import { createGithubClient } from "../../apps/web/src/server/lib/github-client";
import { factoryFixture } from "./factory-snapshot";

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
	const state = factoryFixture();
	state.account_id = "account_123";
	state.inventory.complete = true;
	state.contributionStatus = "complete";
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
export function github(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	return createGithubClient({ ENVIRONMENT: "production" } as Env, (url, init) =>
		Promise.resolve(handler(String(url), init)),
	);
}
