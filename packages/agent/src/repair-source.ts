import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { GiraffeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { ownedRepositories, STALE_MS } from "./evidence.ts";
import {
	type DependencyPlan,
	type IssueCandidate,
	issueCandidateSchema,
	type LiveIssue,
	liveIssueSchema,
} from "./repair-contracts.ts";

const runFile = promisify(execFile);
export type GithubRead = (path: string, signal?: AbortSignal) => Promise<unknown>;
export class LiveStateChanged extends Error {}
export const githubRead: GithubRead = async (path, signal) => {
	if (!/^(?:user|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_%?=&.+/-]+)?)$/.test(path))
		throw new Error("Invalid GitHub read path.");
	try {
		const result = await runFile(
			"gh",
			["api", "--hostname", "github.com", "--method", "GET", path],
			{
				timeout: 30000,
				maxBuffer: 1024 * 1024,
				...(signal ? { signal } : {}),
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					GH_PROMPT_DISABLED: "1",
					GH_NO_UPDATE_NOTIFIER: "1",
				},
			},
		);
		return JSON.parse(result.stdout);
	} catch {
		throw new Error("GitHub read failed; no mutation was attempted.");
	}
};

export async function dependencyCandidates(
	client: GiraffeClient,
	_config: Config,
	now: string,
): Promise<IssueCandidate[]> {
	const identity = await client.me();
	const catalog = await client.observation("repos?scope=all");
	const allowed = new Set(ownedRepositories(catalog, identity.login));
	const issues = await client.observation("issues?scope=all");
	if (issues.truncated || issues.unavailable) throw new Error("Issue snapshot is incomplete.");
	const data = issues.data;
	const list = z.array(z.record(z.string(), z.unknown())).parse(data.issues);
	const times = z.record(z.string(), z.string()).parse(data.repository_fetched_at ?? {});
	const seen = new Set<string>();
	return list.flatMap((raw) => {
		const repository = typeof raw.name_with_owner === "string" ? raw.name_with_owner : "";
		const title = typeof raw.title === "string" ? raw.title : "";
		const labels = z
			.array(z.object({ name: z.string() }))
			.parse(raw.labels ?? [])
			.map((label) => label.name);
		const fetchedAt = times[repository] ?? issues.fetchedAt;
		if (
			!allowed.has(repository) ||
			!fetchedAt ||
			!Number.isFinite(Date.parse(fetchedAt)) ||
			Date.parse(now) - Date.parse(fetchedAt) > STALE_MS ||
			Date.parse(fetchedAt) > Date.parse(now) + 60000 ||
			!(
				/\b(deps|dependency|dependencies|upgrade|bump)\b|依赖.*升级/i.test(title) ||
				labels.includes("dependencies")
			)
		)
			return [];
		const parsed = issueCandidateSchema.safeParse({
			repository,
			number: raw.number,
			title,
			labels,
			url: raw.url,
			updatedAt: raw.updated_at,
			sourceVersion: issues.sourceVersion,
			fetchedAt,
		});
		if (!parsed.success) return [];
		const key = `${repository}#${parsed.data.number}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [parsed.data];
	});
}

export async function verifyLiveIssue(
	candidate: IssueCandidate,
	owner: string,
	read = githubRead,
	signal?: AbortSignal,
): Promise<LiveIssue> {
	const identity = z.object({ login: z.string() }).parse(await read("user", signal));
	if (identity.login !== owner)
		throw new Error("GitHub identity does not match the Giraffe account.");
	const repo = z
		.object({
			id: z.number(),
			full_name: z.string(),
			owner: z.object({ login: z.string() }),
			archived: z.boolean(),
			fork: z.boolean(),
			disabled: z.boolean().optional(),
			default_branch: z.string(),
		})
		.parse(await read(`repos/${candidate.repository}`, signal));
	if (
		repo.owner.login !== owner ||
		repo.full_name !== candidate.repository ||
		repo.archived ||
		repo.fork ||
		repo.disabled ||
		candidate.repository.toLowerCase() === "nocoo/rsshub"
	)
		throw new LiveStateChanged("Repository is not eligible for repair.");
	const issue = z
		.object({
			number: z.number(),
			title: z.string(),
			body: z.string().nullable(),
			state: z.string(),
			html_url: z.string(),
			updated_at: z.string(),
			labels: z.array(z.object({ name: z.string() })),
			user: z.object({ login: z.string() }),
			pull_request: z.unknown().optional(),
		})
		.parse(await read(`repos/${candidate.repository}/issues/${candidate.number}`, signal));
	if (issue.pull_request || issue.state !== "open" || issue.number !== candidate.number)
		throw new LiveStateChanged("Issue is no longer open or is a pull request.");
	if (issue.updated_at !== candidate.updatedAt)
		throw new LiveStateChanged("Saved issue changed on GitHub; wait for refreshed observations.");
	const branch = z
		.object({ commit: z.object({ sha: z.string() }) })
		.parse(
			await read(
				`repos/${candidate.repository}/branches/${encodeURIComponent(repo.default_branch)}`,
				signal,
			),
		);
	return liveIssueSchema.parse({
		...candidate,
		title: issue.title,
		body: issue.body ?? "",
		state: "open",
		labels: issue.labels.map((label) => label.name),
		author: issue.user.login,
		updatedAt: issue.updated_at,
		url: issue.html_url,
		baseSha: branch.commit.sha,
		defaultBranch: repo.default_branch,
		repositoryId: String(repo.id),
		verifiedAt: new Date().toISOString(),
	});
}

export function assertSameIssue(before: LiveIssue, after: LiveIssue): void {
	if (
		before.repositoryId !== after.repositoryId ||
		before.baseSha !== after.baseSha ||
		before.defaultBranch !== after.defaultBranch ||
		before.number !== after.number ||
		before.updatedAt !== after.updatedAt ||
		before.body !== after.body ||
		before.title !== after.title
	) {
		throw new Error("Issue or default branch changed; restart planning and review.");
	}
}

export async function packageTarget(
	plan: DependencyPlan,
	registry: string,
	transport: typeof fetch = fetch,
): Promise<void> {
	const base = new URL(registry);
	if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
		throw new Error("Registry must be HTTPS without credentials.");
	const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(plan.dependency)}/${encodeURIComponent(plan.targetVersion)}`;
	const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
	if (!response.ok) throw new Error("Requested dependency version could not be verified.");
	const metadata = z.object({ name: z.string(), version: z.string() }).parse(await response.json());
	if (metadata.name !== plan.dependency || metadata.version !== plan.targetVersion)
		throw new Error("Dependency registry metadata mismatch.");
}
