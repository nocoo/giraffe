export type NavItem = { href: string; label: string; icon: string };

export const NAV_ITEMS: readonly NavItem[] = [
	{ href: "/", label: "仓库", icon: "Box" },
	{ href: "/issues", label: "Issues", icon: "CircleDot" },
	{ href: "/pulls", label: "Pull Requests", icon: "GitPullRequest" },
	{ href: "/insights", label: "Insights", icon: "Activity" },
	{ href: "/alerts", label: "安全告警", icon: "ShieldAlert" },
	{ href: "/inbox", label: "通知", icon: "Inbox" },
	{ href: "/digest", label: "日报", icon: "Newspaper" },
	{ href: "/settings", label: "设置", icon: "Settings" },
];

export type PaletteItem = { href: string; label: string };

export function paletteItems(
	repos: { name_with_owner: string; owner_login: string; name: string }[] | null,
): PaletteItem[] {
	const items: PaletteItem[] = NAV_ITEMS.map((item) => ({ href: item.href, label: item.label }));
	if (!repos) {
		return items;
	}
	return [
		...items,
		...repos.map((row) => ({
			href: `/repos/${row.owner_login}/${row.name}`,
			label: row.name_with_owner,
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
