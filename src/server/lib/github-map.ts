export type Capabilities = {
	repo: boolean;
	"read:org": boolean;
	"read:user": boolean;
	notifications: boolean;
};

const REQUIRED = ["repo", "read:org", "read:user", "notifications"] as const;

export function parseScopes(header: string | null): {
	scopes: string;
	capabilities: Capabilities;
	missing: boolean;
} {
	const scopes = header ?? "";
	const parts = scopes
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const set = new Set(parts);
	const capabilities: Capabilities = {
		repo: set.has("repo"),
		"read:org": set.has("read:org"),
		"read:user": set.has("read:user"),
		notifications: set.has("notifications"),
	};
	return { scopes, capabilities, missing: REQUIRED.some((s) => !set.has(s)) };
}

export function mapUser(body: { login?: string; avatar_url?: string }): {
	login: string;
	avatar_url: string;
} {
	return { login: body.login ?? "", avatar_url: body.avatar_url ?? "" };
}

export function mapRepos(nodes: Array<Record<string, unknown>>): unknown[] {
	return nodes.map((n) => {
		const owner = n.owner as { login?: string } | undefined;
		const language = n.primaryLanguage as { name?: string } | undefined;
		const issues = n.issues as { totalCount?: number } | undefined;
		return {
			name_with_owner: String(n.nameWithOwner ?? ""),
			name: n.name,
			owner_login: owner?.login ?? "",
			description: n.description ?? null,
			stargazer_count: Number(n.stargazerCount ?? 0),
			fork_count: Number(n.forkCount ?? 0),
			open_issue_count: Number(n.openIssueCount ?? issues?.totalCount ?? 0),
			primary_language: language?.name ?? null,
			pushed_at: n.pushedAt ?? null,
			visibility:
				typeof n.visibility === "string" ? n.visibility : n.isPrivate ? "PRIVATE" : "PUBLIC",
			is_private: Boolean(n.isPrivate),
			is_archived: Boolean(n.isArchived),
			is_fork: Boolean(n.isFork),
			url: n.url,
		};
	});
}

function loginOf(author: unknown): string | null {
	if (!author || typeof author !== "object") {
		return null;
	}
	const login = (author as { login?: unknown }).login;
	return typeof login === "string" ? login : null;
}

function repoName(node: Record<string, unknown>): string {
	const repo = node.repository as { nameWithOwner?: string } | undefined;
	return String(repo?.nameWithOwner ?? node.name_with_owner ?? "");
}

export function mapIssues(nodes: unknown[]): unknown[] {
	return nodes.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		if (n.__typename === "PullRequest") {
			return [];
		}
		const labels = n.labels as { nodes?: Array<{ name?: string; color?: string }> } | undefined;
		const comments = n.comments as { totalCount?: number } | undefined;
		return [
			{
				name_with_owner: repoName(n),
				number: Number(n.number ?? 0),
				title: String(n.title ?? ""),
				url: String(n.url ?? ""),
				created_at: String(n.createdAt ?? n.created_at ?? ""),
				updated_at: String(n.updatedAt ?? n.updated_at ?? ""),
				author_login: loginOf(n.author),
				labels: (labels?.nodes ?? []).map((label) => ({
					name: label.name ?? "",
					color: label.color ?? "ededed",
				})),
				comments_count: Number(comments?.totalCount ?? n.comments_count ?? 0),
			},
		];
	});
}

export function mapPullRequests(nodes: unknown[]): unknown[] {
	return nodes.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		if (n.__typename === "Issue") {
			return [];
		}
		return [
			{
				name_with_owner: repoName(n),
				number: Number(n.number ?? 0),
				title: String(n.title ?? ""),
				url: String(n.url ?? ""),
				created_at: String(n.createdAt ?? n.created_at ?? ""),
				updated_at: String(n.updatedAt ?? n.updated_at ?? ""),
				author_login: loginOf(n.author),
				is_draft: Boolean(n.isDraft ?? n.draft),
				review_decision: n.reviewDecision ?? n.review_decision ?? null,
				additions: Number(n.additions ?? 0),
				deletions: Number(n.deletions ?? 0),
				base_ref: String(n.baseRefName ?? n.base_ref ?? ""),
				head_ref: String(n.headRefName ?? n.head_ref ?? ""),
			},
		];
	});
}

export function mapNotifications(rows: unknown[]): unknown[] {
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		const subject = n.subject as { title?: string; url?: string } | undefined;
		const repo = n.repository as { full_name?: string } | undefined;
		return [
			{
				id: String(n.id ?? ""),
				unread: Boolean(n.unread),
				reason: String(n.reason ?? ""),
				updated_at: String(n.updated_at ?? ""),
				title: String(subject?.title ?? n.title ?? ""),
				url: String(subject?.url ?? n.url ?? ""),
				name_with_owner: String(repo?.full_name ?? n.name_with_owner ?? ""),
			},
		];
	});
}

export function mapDependabotAlerts(nameWithOwner: string, nodes: unknown[]): unknown[] {
	return nodes.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		const advisory = n.securityAdvisory as { summary?: string; permalink?: string } | undefined;
		const vuln = n.securityVulnerability as { severity?: string } | undefined;
		return [
			{
				name_with_owner: nameWithOwner,
				source: "dependabot",
				severity: String(vuln?.severity ?? "").toLowerCase(),
				summary: String(advisory?.summary ?? ""),
				url: String(advisory?.permalink ?? ""),
			},
		];
	});
}

export function mapCodeScanningAlerts(nameWithOwner: string, rows: unknown[]): unknown[] {
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		const rule = n.rule as { description?: string; security_severity_level?: string } | undefined;
		return [
			{
				name_with_owner: nameWithOwner,
				source: "code_scanning",
				severity: String(rule?.security_severity_level ?? n.severity ?? "").toLowerCase(),
				summary: String(rule?.description ?? n.summary ?? ""),
				url: String(n.html_url ?? n.url ?? ""),
			},
		];
	});
}

export function mapRepoDetails(body: Record<string, unknown>): Record<string, unknown> {
	const license = body.license as { spdx_id?: string } | string | null | undefined;
	return {
		description: body.description ?? null,
		homepage: body.homepage ?? null,
		default_branch: String(body.default_branch ?? ""),
		license: typeof license === "string" ? license : (license?.spdx_id ?? null),
		is_archived: Boolean(body.archived ?? body.is_archived),
		open_issue_count: Number(body.open_issues_count ?? body.open_issue_count ?? 0),
		stargazer_count: Number(body.stargazers_count ?? body.stargazer_count ?? 0),
		fork_count: Number(body.forks_count ?? body.fork_count ?? 0),
		pushed_at: String(body.pushed_at ?? ""),
		url: String(body.html_url ?? body.url ?? ""),
	};
}

export function mapActionRuns(body: unknown): unknown[] {
	const runs =
		body &&
		typeof body === "object" &&
		Array.isArray((body as { workflow_runs?: unknown[] }).workflow_runs)
			? (body as { workflow_runs: unknown[] }).workflow_runs
			: [];
	return runs.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		return [
			{
				id: Number(n.id ?? 0),
				name: String(n.name ?? ""),
				html_url: String(n.html_url ?? ""),
				status: String(n.status ?? ""),
				conclusion: n.conclusion ?? null,
				event: String(n.event ?? ""),
				head_branch: n.head_branch ?? null,
				created_at: String(n.created_at ?? ""),
				updated_at: String(n.updated_at ?? ""),
			},
		];
	});
}

export function mapTraffic(
	body: unknown,
	listKey: "views" | "clones",
): {
	count: number;
	uniques: number;
	points: unknown[];
} {
	if (!body || typeof body !== "object") {
		return { count: 0, uniques: 0, points: [] };
	}
	const n = body as Record<string, unknown>;
	const points = Array.isArray(n[listKey])
		? (n[listKey] as unknown[])
		: Array.isArray(n.points)
			? n.points
			: [];
	return {
		count: Number(n.count ?? 0),
		uniques: Number(n.uniques ?? 0),
		points,
	};
}

export function mapReleases(rows: unknown[]): unknown[] {
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		return [
			{
				id: Number(n.id ?? 0),
				tag_name: String(n.tag_name ?? ""),
				name: n.name ?? null,
				html_url: String(n.html_url ?? ""),
				draft: Boolean(n.draft),
				prerelease: Boolean(n.prerelease),
				published_at: n.published_at ?? null,
			},
		];
	});
}

export function mapContributors(rows: unknown[]): unknown[] {
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const n = raw as Record<string, unknown>;
		return [
			{
				login: String(n.login ?? ""),
				avatar_url: String(n.avatar_url ?? ""),
				html_url: String(n.html_url ?? ""),
				contributions: Number(n.contributions ?? 0),
			},
		];
	});
}

export function emptyTraffic(): { count: number; uniques: number; points: unknown[] } {
	return { count: 0, uniques: 0, points: [] };
}
