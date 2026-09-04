export type NavItem = { href: string; label: string; icon: string };

export const NAV_ITEMS: readonly NavItem[] = [
	{ href: "/insights", label: "Insights", icon: "Activity" },
	{ href: "/", label: "仓库", icon: "Box" },
	{ href: "/issues", label: "Issues", icon: "CircleDot" },
	{ href: "/pulls", label: "Pull Requests", icon: "GitPullRequest" },
	{ href: "/alerts", label: "安全告警", icon: "ShieldAlert" },
	{ href: "/inbox", label: "通知", icon: "Inbox" },
	{ href: "/digest", label: "日报", icon: "Newspaper" },
	{ href: "/settings", label: "设置", icon: "Settings" },
];

export type NavGroup = { label: string; items: readonly NavItem[] };

export const NAV_GROUPS: readonly NavGroup[] = [
	{ label: "浏览", items: NAV_ITEMS.slice(0, 4) },
	{ label: "工作", items: NAV_ITEMS.slice(4, 7) },
	{ label: "系统", items: NAV_ITEMS.slice(7) },
];

export const PAGE_DESCRIPTIONS = {
	"/": "当前账号下的仓库快照",
	"/issues": "跨仓打开的 Issue",
	"/pulls": "跨仓打开的 Pull Request",
	"/insights": "跨仓 Issue / PR 分布与仓库健康",
	"/alerts": "Dependabot 与 code scanning",
	"/inbox": "GitHub 通知收件箱",
	"/digest": "相对昨天基线的仓库变化",
	"/settings": "Access 身份与 GitHub 账号",
} as const;

export type PaletteItem = { href: string; label: string; icon: string };

export function paletteItems(
	repos: { name_with_owner: string; owner_login: string; name: string }[] | null,
): PaletteItem[] {
	const items: PaletteItem[] = NAV_ITEMS.map((item) => ({
		href: item.href,
		label: item.label,
		icon: item.icon,
	}));
	if (!repos) {
		return items;
	}
	return [
		...items,
		...repos.map((row) => ({
			href: `/repos/${row.owner_login}/${row.name}`,
			label: row.name_with_owner,
			icon: "Box",
		})),
	];
}

export function breadcrumbsFor(pathname: string): { href: string; label: string }[] {
	if (pathname === "/") {
		return [{ href: "/", label: "仓库" }];
	}
	const repo = /^\/repos\/([^/]+)\/([^/]+)/.exec(pathname);
	if (repo?.[1] && repo[2]) {
		return [
			{ href: "/", label: "仓库" },
			{ href: `/repos/${repo[1]}/${repo[2]}`, label: `${repo[1]}/${repo[2]}` },
		];
	}
	const item = NAV_ITEMS.find((row) => row.href === pathname);
	if (item) {
		return [{ href: item.href, label: item.label }];
	}
	return [{ href: pathname, label: "未找到" }];
}

export function headerTitle(pathname: string): string {
	const crumbs = breadcrumbsFor(pathname);
	let label = "未找到";
	for (const crumb of crumbs) {
		label = crumb.label;
	}
	return label;
}

export function headerCrumbs(pathname: string): { href: string; label: string }[] {
	const crumbs = breadcrumbsFor(pathname);
	if (crumbs.length > 1) {
		return crumbs.slice(0, -1);
	}
	return [{ href: "/", label: "Giraffe" }];
}
