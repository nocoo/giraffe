const fetchedAt = "2026-09-08T08:30:00.000Z";
const envelope = { account_id: "ui-account", fetched_at: fetchedAt, truncated: false };

export function createUiFixtures() {
	const repos = [
		{
			name: "hello-world",
			description: "A demo repo · 个人项目的入口与开发工具",
			language: "TypeScript",
		},
		{
			name: "basalt",
			description: "共享控件、图表和应用布局，让每个产品保持一致。",
			language: "TypeScript",
		},
		{ name: "field-notes", description: "关于设计与开发的日常记录", language: "MDX" },
		{
			name: "a-repository-with-a-very-long-name-for-layout-verification",
			description: null,
			language: "Python",
		},
	].map((repo, index) => ({
		name: repo.name,
		name_with_owner: `octocat/${repo.name}`,
		owner_login: "octocat",
		description: repo.description,
		primary_language: repo.language,
		stargazer_count: 1240 - index * 120,
		fork_count: 38 - index * 3,
		open_issue_count: 12 - index * 2,
		pushed_at: fetchedAt,
		visibility: index === 2 ? "private" : "public",
		is_private: index === 2,
		is_archived: index === 3,
		is_fork: false,
		url: `https://github.com/octocat/${repo.name}`,
	}));
	const issues = [
		"优化长标题在窄屏中的展示与键盘导航",
		"为共享控件补充使用说明",
		"Investigate-really-long-unbroken-issue-titles-that-should-never-push-actions-out-of-the-viewport",
	].map((title, index) => ({
		name_with_owner: index === 1 ? "octocat/basalt" : "octocat/hello-world",
		number: 41 + index,
		title,
		url: `https://github.com/octocat/hello-world/issues/${41 + index}`,
		created_at: fetchedAt,
		updated_at: fetchedAt,
		author_login: "octocat",
		labels: [
			{ name: "enhancement", color: "a2eeef" },
			{ name: "accessibility", color: "7057ff" },
			{ name: "needs-review", color: "fbca04" },
		],
		comments_count: 3 + index,
	}));
	const pulls = [null, "REVIEW_REQUIRED", "CHANGES_REQUESTED", "APPROVED", null].map(
		(review, index) => ({
			name_with_owner: "octocat/hello-world",
			number: 80 + index,
			title: ["探索新的导航结构", "完善资源列表", "调整表单提示", "更新共享控件", "整理项目文档"][
				index
			],
			url: `https://github.com/octocat/hello-world/pull/${80 + index}`,
			created_at: fetchedAt,
			updated_at: fetchedAt,
			author_login: "octocat",
			is_draft: index === 0,
			review_decision: review,
			additions: 124 + index * 10,
			deletions: 28,
			base_ref: "main",
			head_ref: "feature/ui-polish",
		}),
	);
	const repoPath = "/api/repos/octocat/hello-world";
	return {
		"/api/me": { name: "演示账号", email: "demo@example.test", avatar: null },
		"/api/accounts": {
			accounts: [
				{
					id: envelope.account_id,
					login: "octocat",
					avatar_url: "",
					token_last4: "AAAA",
					is_active: true,
					scopes: "repo, read:org, read:user, notifications",
				},
			],
		},
		"/api/repos": { ...envelope, repos },
		"/api/issues": { ...envelope, issues },
		"/api/prs": { ...envelope, pull_requests: pulls },
		"/api/insights": {
			...envelope,
			alerts_incomplete: false,
			insights: repos.map((repo, index) => ({
				name_with_owner: repo.name_with_owner,
				open_issue_count: repo.open_issue_count,
				days_since_push: index * 15,
				health: index === 3 ? "risky" : index === 2 ? "watch" : "strong",
				alerts: [],
				opportunities: [],
			})),
		},
		"/api/alerts": {
			...envelope,
			unavailable: false,
			dependabot_open: 2,
			code_scanning_open: 1,
			items: ["high", "medium", "low"].map((severity, index) => ({
				name_with_owner: "octocat/hello-world",
				source: index === 2 ? "code_scanning" : "dependabot",
				severity,
				summary: ["升级存在漏洞的依赖版本", "修复请求处理中的边界条件", "检查未使用的返回值"][
					index
				],
				url: `https://github.com/octocat/hello-world/security/${index + 1}`,
			})),
		},
		"/api/notifications": {
			...envelope,
			notifications: issues.map((issue, index) => ({
				id: String(index + 1),
				unread: index !== 2,
				reason: index === 0 ? "mention" : "subscribed",
				updated_at: fetchedAt,
				title: issue.title,
				url: issue.url,
				name_with_owner: issue.name_with_owner,
			})),
		},
		"/api/digest": {
			...envelope,
			day: "2026-09-08",
			baseline_missing: false,
			stars_delta: 12,
			forks_delta: 4,
			open_issues_delta: -2,
			repos: repos.map((repo, index) => ({
				name_with_owner: repo.name_with_owner,
				stars_delta: 3,
				forks_delta: 1,
				open_issues_delta: index < 2 ? -1 : 0,
			})),
		},
		[repoPath]: {
			...envelope,
			description: repos[0]?.description,
			homepage: "https://example.test",
			default_branch: "main",
			license: "MIT",
			is_archived: false,
			open_issue_count: 12,
			stargazer_count: 1240,
			fork_count: 38,
			pushed_at: fetchedAt,
			url: "https://github.com/octocat/hello-world",
		},
		[`${repoPath}/security`]: {
			...envelope,
			unavailable: false,
			dependabot_open: 2,
			code_scanning_open: 1,
		},
		[`${repoPath}/actions`]: {
			...envelope,
			runs: [
				{
					id: 1,
					name: "Build and test",
					html_url: "https://github.com/octocat/hello-world/actions/runs/1",
					status: "completed",
					conclusion: "success",
					event: "push",
					head_branch: "main",
					created_at: fetchedAt,
					updated_at: fetchedAt,
				},
			],
		},
		[`${repoPath}/releases`]: {
			...envelope,
			releases: [
				{
					id: 1,
					tag_name: "v2.1.0",
					name: "共享控件与体验改进",
					html_url: "https://github.com/octocat/hello-world/releases/tag/v2.1.0",
					draft: false,
					prerelease: false,
					published_at: fetchedAt,
				},
			],
		},
		[`${repoPath}/issues`]: { ...envelope, issues },
		[`${repoPath}/prs`]: { ...envelope, pull_requests: pulls },
		[`${repoPath}/traffic`]: {
			...envelope,
			forbidden: false,
			views: {
				count: 120,
				uniques: 84,
				points: [
					{ timestamp: "2026-09-07", count: 48, uniques: 32 },
					{ timestamp: "2026-09-08", count: 72, uniques: 52 },
				],
			},
			clones: {
				count: 24,
				uniques: 18,
				points: [
					{ timestamp: "2026-09-07", count: 10, uniques: 8 },
					{ timestamp: "2026-09-08", count: 14, uniques: 10 },
				],
			},
		},
		[`${repoPath}/languages`]: {
			...envelope,
			languages: { TypeScript: 124000, CSS: 16000, HTML: 4000 },
		},
		[`${repoPath}/contributors`]: {
			...envelope,
			contributors: [
				{
					login: "octocat",
					avatar_url: "",
					html_url: "https://github.com/octocat",
					contributions: 124,
				},
				{
					login: "reviewer",
					avatar_url: "",
					html_url: "https://github.com/reviewer",
					contributions: 38,
				},
			],
		},
	};
}
