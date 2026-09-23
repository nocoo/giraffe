import { emptyMetrics } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryCoverage,
	type FactoryEvent,
	type FactoryRepo,
	type FactoryStreamName,
} from "../../lib/factory-types";

export type GithubObject = Record<string, unknown>;
export function object(value: unknown): GithubObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as GithubObject) : {};
}
export function rows(value: unknown): GithubObject[] {
	return Array.isArray(value) ? value.map(object) : [];
}
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function nullable(value: unknown): string | null {
	return str(value) || null;
}
export function coverage(source = ""): FactoryCoverage {
	return { status: "pending", pages: 0, fetchedAt: null, source, reason: null, observed: 0 };
}
export function exclusion(r: GithubObject, owner: string, includeDisabled = false): string | null {
	if (str(object(r.owner).login).toLowerCase() !== owner.toLowerCase()) return "not-owner";
	if (!includeDisabled && r.isArchived === true) return "archived";
	if (!includeDisabled && r.isFork === true) return "fork";
	if (str(r.nameWithOwner).toLowerCase() === "nocoo/rsshub") return "effective-mirror";
	return null;
}
export function mapFactoryRepo(r: GithubObject): FactoryRepo {
	const branch = object(r.defaultBranchRef);
	const target = object(branch.target);
	const lang = object(r.languages);
	const count = (key: string) => Number(object(r[key]).totalCount ?? 0);
	return {
		is_fork: r.isFork === true,
		is_archived: r.isArchived === true,
		id: str(r.id),
		name: str(r.nameWithOwner),
		url: str(r.url),
		description: nullable(r.description),
		private: r.isPrivate === true,
		diskKiB: Number(r.diskUsage ?? 0),
		pushedAt: nullable(r.pushedAt),
		language: str(object(r.primaryLanguage).name) || "未标记",
		languages: rows(lang.edges).map((e) => ({
			name: str(object(e.node).name),
			bytes: Number(e.size),
		})),
		languageBytes: Number(lang.totalSize ?? 0),
		languagesComplete: Number(lang.totalCount ?? 0) <= 100,
		topics: rows(object(r.repositoryTopics).nodes).map((t) => str(object(t.topic).name)),
		branch: nullable(branch.name),
		head: nullable(target.oid),
		totalCommits: Number(object(target.history).totalCount ?? 0),
		openIssues: count("openIssues"),
		closedIssues: count("closedIssues"),
		openPrs: count("openPrs"),
		closedPrs: count("closedPrs"),
		mergedPrs: count("mergedPrs"),
		totalReleases: count("releases"),
		coverage: Object.fromEntries(
			FACTORY_STREAMS.map((k) => [k, coverage()]),
		) as FactoryRepo["coverage"],
		metrics: emptyMetrics(),
		dependencies: [],
	};
}
export function mapFactoryEvents(stream: FactoryStreamName, data: GithubObject[]): FactoryEvent[] {
	return data
		.filter((r) => stream !== "issues" || !r.pull_request)
		.map((r) => {
			const commit = object(r.commit);
			const at = str(r.created_at);
			const event: FactoryEvent = {
				id: str(r.node_id) || String(r.id ?? r.sha ?? r.number),
				title: str(r.title ?? r.name ?? r.tag_name).slice(0, 240),
				url: str(r.html_url),
				at,
				createdAt: at,
				closedAt: nullable(r.closed_at),
				mergedAt: nullable(r.merged_at),
				author: str(object(r.user ?? r.author ?? r.actor).login) || "unlinked",
				state: str(r.state ?? r.status),
			};
			if (stream === "commits") {
				event.id = str(r.sha);
				event.at = str(object(commit.committer).date);
				event.createdAt = event.at;
				event.title = str(commit.message).split("\n")[0]?.slice(0, 240) ?? "";
				event.state = "committed";
			}
			if (stream === "prs") {
				event.state = event.mergedAt ? "merged" : event.state;
				event.draft = r.draft === true;
			}
			if (stream === "actions") event.conclusion = nullable(r.conclusion);
			if (stream === "releases") {
				event.at = str(r.published_at);
				event.state =
					r.draft === true ? "draft" : r.prerelease === true ? "prerelease" : "published";
			}
			if (stream === "alerts") {
				event.id = String(r.number);
				event.title = `${str(object(object(r.dependency).package).name)} · ${str(object(r.security_advisory).severity)}`;
			}
			return event;
		});
}
/** Manifest evidence only: direct root npm dependencies and two named CI entrypoints. */
export function mapDependencies(data: GithubObject, repo: FactoryRepo): FactoryEvent[] {
	const items: FactoryEvent[] = [];
	const base = `${repo.url}/blob/${repo.head}`;
	const add = (name: string, version: string, path: string) =>
		items.push({
			id: `${path}:${name}`,
			title: name,
			version,
			path,
			url: `${base}/${path}`,
			at: "",
			createdAt: "",
			closedAt: null,
			mergedAt: null,
			author: "",
			state: "declared",
		});
	const text = object(data.package).text;
	if (typeof text === "string") {
		const pkg = object(JSON.parse(text));
		if (typeof pkg.name === "string")
			add(pkg.name, typeof pkg.version === "string" ? pkg.version : "", "package.json#name");
		for (const key of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies",
		]) {
			for (const [name, version] of Object.entries(object(pkg[key])))
				if (typeof version === "string") add(name, version, `package.json#${key}`);
		}
	}
	for (const [key, path] of [
		["ci", ".github/workflows/ci.yml"],
		["release", ".github/workflows/release.yml"],
	] as const) {
		const content = object(data[key]).text;
		if (typeof content === "string")
			for (const match of content.matchAll(
				/(?:^|\n)\s*(?:-\s*)?uses:\s*["']?([\w.-]+\/[\w./-]+)@([^\s"'#]+)/g,
			))
				add(match[1] ?? "", match[2] ?? "", path);
	}
	for (const [key, path] of [
		["dependabot", ".github/dependabot.yml"],
		["renovate", "renovate.json"],
	] as const)
		if (typeof object(data[key]).text === "string") add(key, "configured", path);
	return items;
}
