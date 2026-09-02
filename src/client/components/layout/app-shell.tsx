import {
	ContentIsland,
	Sidebar,
	SidebarFooter,
	SidebarHeader,
	SidebarIconItem,
	SidebarItem,
	SidebarNav,
	SidebarProvider,
	SidebarUser,
	ThemeToggle,
} from "@nocoo/basalt";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";
import { Breadcrumbs } from "@nocoo/basalt/components/breadcrumbs";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
	Activity,
	Box,
	CircleDot,
	GitPullRequest,
	Inbox,
	Newspaper,
	Settings,
	ShieldAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { APP_VERSION } from "../../../lib/version";
import { breadcrumbsFor, NAV_ITEMS } from "../../lib/navigation";

const ICONS: Record<string, ReactNode> = {
	Box: <Box className="h-4 w-4" strokeWidth={1.5} />,
	CircleDot: <CircleDot className="h-4 w-4" strokeWidth={1.5} />,
	GitPullRequest: <GitPullRequest className="h-4 w-4" strokeWidth={1.5} />,
	Activity: <Activity className="h-4 w-4" strokeWidth={1.5} />,
	ShieldAlert: <ShieldAlert className="h-4 w-4" strokeWidth={1.5} />,
	Inbox: <Inbox className="h-4 w-4" strokeWidth={1.5} />,
	Newspaper: <Newspaper className="h-4 w-4" strokeWidth={1.5} />,
	Settings: <Settings className="h-4 w-4" strokeWidth={1.5} />,
};

function navActive(pathname: string, href: string): boolean {
	if (href === "/") {
		return pathname === "/" || pathname.startsWith("/repos/");
	}
	return pathname === href;
}

function SideNav() {
	const { collapsed } = useSidebar();
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<SidebarNav>
			{NAV_ITEMS.map((item) => {
				const active = navActive(location.pathname, item.href);
				const icon = ICONS[item.icon];
				if (collapsed) {
					return (
						<SidebarIconItem
							key={item.href}
							active={active}
							aria-label={item.label}
							onClick={() => navigate(item.href)}
						>
							{icon}
						</SidebarIconItem>
					);
				}
				return (
					<SidebarItem key={item.href} active={active} onClick={() => navigate(item.href)}>
						{icon}
						{item.label}
					</SidebarItem>
				);
			})}
		</SidebarNav>
	);
}

export function AppShell() {
	const location = useLocation();
	const crumbs = breadcrumbsFor(location.pathname);
	return (
		<SidebarProvider defaultWidth={260}>
			<AppSkipLink>跳到主内容</AppSkipLink>
			<Shell>
				<Sidebar>
					<SidebarHeader>
						<span className="truncate text-sm font-semibold">Giraffe</span>
						<span className="rounded-md bg-basalt-secondary px-1.5 py-0.5 font-mono text-[10px]">
							v{APP_VERSION}
						</span>
					</SidebarHeader>
					<SideNav />
					<SidebarFooter>
						<SidebarUser
							name="Giraffe"
							email={`v${APP_VERSION}`}
							action={<ThemeToggle aria-label="切换主题" />}
						/>
					</SidebarFooter>
				</Sidebar>
				<AppMain tabIndex={-1}>
					<header className="flex h-14 shrink-0 items-center px-4 md:px-6">
						<Breadcrumbs items={crumbs.map((item) => ({ href: item.href, label: item.label }))} />
					</header>
					<ContentIsland>
						<Outlet />
					</ContentIsland>
				</AppMain>
			</Shell>
		</SidebarProvider>
	);
}
