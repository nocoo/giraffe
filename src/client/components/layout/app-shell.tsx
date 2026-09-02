import {
	Button,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPalette,
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
	toast,
} from "@nocoo/basalt";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";
import { Breadcrumbs } from "@nocoo/basalt/components/breadcrumbs";
import { Empty } from "@nocoo/basalt/components/empty";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
	Activity,
	Box,
	CircleDot,
	GitPullRequest,
	Inbox,
	Newspaper,
	PanelLeft,
	Settings,
	ShieldAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { APP_VERSION } from "../../../lib/version";
import { reportError, subscribeErrorUi } from "../../lib/error-ui";
import { breadcrumbsFor, NAV_ITEMS, paletteItems } from "../../lib/navigation";
import { displayName, loadMe, type MeIdentity } from "../../viewmodels/me";
import { cachedRepoRows } from "../../viewmodels/repos";

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

function CollapseButton() {
	const { collapsed, setCollapsed } = useSidebar();
	return (
		<Button
			type="button"
			variant="ghost"
			aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
			onClick={() => setCollapsed(!collapsed)}
		>
			<PanelLeft className="h-4 w-4" strokeWidth={1.5} />
		</Button>
	);
}

function Palette() {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const items = paletteItems(cachedRepoRows());

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if ((event.metaKey || event.ctrlKey) && event.key === "k") {
				event.preventDefault();
				setOpen(true);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<CommandPalette open={open} onOpenChange={setOpen}>
			<CommandInput placeholder="搜索页面或仓库" />
			<CommandList>
				<CommandEmpty>没有匹配项</CommandEmpty>
				<CommandGroup heading="导航">
					{items.map((item) => (
						<CommandItem
							key={item.href}
							value={`${item.label} ${item.href}`}
							onSelect={() => {
								setOpen(false);
								navigate(item.href);
							}}
						>
							{item.label}
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</CommandPalette>
	);
}

export function AppShell() {
	const location = useLocation();
	const navigate = useNavigate();
	const crumbs = breadcrumbsFor(location.pathname);
	const [me, setMe] = useState<MeIdentity | null>(null);
	const [accessDenied, setAccessDenied] = useState(false);
	const [accountMissing, setAccountMissing] = useState(false);
	useEffect(() => {
		return subscribeErrorUi((ui) => {
			if (ui.kind === "access") {
				setAccessDenied(true);
			}
			if (ui.kind === "account_missing") {
				setAccountMissing(true);
			}
		});
	}, []);
	useEffect(() => {
		void loadMe()
			.then(setMe)
			.catch((err: unknown) => {
				const ui = reportError(err);
				if (ui.kind === "toast") {
					toast(ui.message);
				}
			});
	}, []);
	return (
		<SidebarProvider defaultWidth={260} peek>
			<AppSkipLink>跳到主内容</AppSkipLink>
			<Shell>
				<Sidebar>
					<SidebarHeader>
						<span className="truncate text-sm font-semibold">Giraffe</span>
						<span className="rounded-md bg-basalt-secondary px-1.5 py-0.5 font-mono text-[10px]">
							v{APP_VERSION}
						</span>
						<CollapseButton />
					</SidebarHeader>
					<SideNav />
					<SidebarFooter>
						<SidebarUser
							name={me ? displayName(me) : "Giraffe"}
							email={me?.email ?? `v${APP_VERSION}`}
							action={<ThemeToggle aria-label="切换主题" />}
						/>
					</SidebarFooter>
				</Sidebar>
				<AppMain tabIndex={-1}>
					<Palette />
					<header className="flex h-14 shrink-0 items-center gap-2 px-4 md:px-6">
						<CollapseButton />
						<Breadcrumbs items={crumbs.map((item) => ({ href: item.href, label: item.label }))} />
					</header>
					<ContentIsland>
						{accessDenied ? (
							<Empty title="未通过 Access" description="此应用需要 Cloudflare Access 身份。" />
						) : (
							<>
								{accountMissing ? (
									<div className="mb-4 flex items-center justify-between rounded-md border border-basalt-border px-3 py-2 text-sm">
										<span>没有活跃账号</span>
										<Button type="button" variant="secondary" onClick={() => navigate("/settings")}>
											去设置
										</Button>
									</div>
								) : null}
								<Outlet />
							</>
						)}
					</ContentIsland>
				</AppMain>
			</Shell>
		</SidebarProvider>
	);
}
