import {
	Avatar,
	AvatarFallback,
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
	SidebarGroup,
	SidebarHeader,
	SidebarIconItem,
	SidebarItem,
	SidebarNav,
	SidebarProvider,
	SidebarSearch,
	SidebarUser,
	ThemeToggle,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	toast,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";
import { Banner } from "@nocoo/basalt/components/banner";
import { Empty } from "@nocoo/basalt/components/empty";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
	Activity,
	Binoculars,
	Box,
	CircleDot,
	GitPullRequest,
	Inbox,
	type LucideIcon,
	Menu,
	Newspaper,
	PanelLeft,
	Search,
	Settings,
	ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { APP_VERSION } from "../../../lib/version";
import { reportError, subscribeErrorUi } from "../../lib/error-ui";
import { initials } from "../../lib/format";
import {
	headerCrumbs,
	headerTitle,
	NAV_GROUPS,
	NAV_ITEMS,
	type NavItem,
	paletteItems,
} from "../../lib/navigation";
import { displayName, loadMe, type MeIdentity } from "../../viewmodels/me";
import { cachedRepoRows } from "../../viewmodels/repos";

const ICONS: Record<string, LucideIcon> = {
	Box,
	CircleDot,
	GitPullRequest,
	Activity,
	ShieldAlert,
	Inbox,
	Newspaper,
	Settings,
};

function NavIcon({ name, className }: { name: string; className?: string }) {
	const Icon = ICONS[name] ?? Box;
	return <Icon className={className ?? "h-4 w-4 shrink-0"} strokeWidth={1.5} />;
}

function navActive(pathname: string, href: string): boolean {
	if (href === "/") {
		return pathname === "/" || pathname.startsWith("/repos/");
	}
	return pathname === href;
}

function CollapseButton({ compact }: { compact?: boolean }) {
	const { collapsed, overlay, setCollapsed } = useSidebar();
	const expanding = overlay ? collapsed : !collapsed;
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={compact ? "h-7 w-7" : "mb-1"}
			aria-label={expanding ? "展开侧栏" : "折叠侧栏"}
			onClick={() => setCollapsed(!collapsed)}
		>
			{overlay && collapsed ? (
				<Menu className="h-4 w-4" strokeWidth={1.5} />
			) : (
				<PanelLeft className="h-4 w-4" strokeWidth={1.5} />
			)}
		</Button>
	);
}

function HeaderBrand() {
	const { collapsed, peeking } = useSidebar();
	const compact = collapsed && !peeking;
	if (compact) {
		return (
			<SidebarHeader className="justify-center px-0">
				<Binoculars className="h-5 w-5 text-basalt-primary" aria-hidden strokeWidth={1.5} />
			</SidebarHeader>
		);
	}
	return (
		<SidebarHeader>
			<div className="flex w-full items-center justify-between px-3">
				<div className="flex min-w-0 items-center gap-3">
					<Binoculars
						className="h-5 w-5 shrink-0 text-basalt-primary"
						aria-hidden
						strokeWidth={1.5}
					/>
					<span className="truncate text-lg font-semibold text-basalt-foreground md:text-xl">
						Giraffe
					</span>
					<span className="rounded-md bg-basalt-secondary px-1.5 py-0.5 text-[10px] leading-none font-medium text-basalt-muted-foreground">
						v{APP_VERSION}
					</span>
				</div>
				<CollapseButton compact />
			</div>
		</SidebarHeader>
	);
}

function NavButton({ item, pathname }: { item: NavItem; pathname: string }) {
	const navigate = useNavigate();
	const { collapsed, peeking } = useSidebar();
	const active = navActive(pathname, item.href);
	if (collapsed && !peeking) {
		return (
			<Tooltip delayDuration={0}>
				<TooltipTrigger asChild>
					<SidebarIconItem
						active={active}
						aria-label={item.label}
						onClick={() => navigate(item.href)}
					>
						<NavIcon name={item.icon} className="h-4 w-4" />
					</SidebarIconItem>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					{item.label}
				</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<SidebarItem active={active} onClick={() => navigate(item.href)}>
			<NavIcon name={item.icon} />
			<span className="flex-1 truncate text-left">{item.label}</span>
		</SidebarItem>
	);
}

function SideNav() {
	const { collapsed, peeking } = useSidebar();
	const location = useLocation();
	const iconsOnly = collapsed && !peeking;
	if (iconsOnly) {
		return (
			<SidebarNav className="w-full items-center gap-1 pt-1">
				{NAV_ITEMS.map((item) => (
					<NavButton key={item.href} item={item} pathname={location.pathname} />
				))}
			</SidebarNav>
		);
	}
	return (
		<SidebarNav className="pt-1">
			{NAV_GROUPS.map((group) => (
				<SidebarGroup key={group.label} label={group.label} defaultOpen>
					{group.items.map((item) => (
						<NavButton key={item.href} item={item} pathname={location.pathname} />
					))}
				</SidebarGroup>
			))}
		</SidebarNav>
	);
}

function FooterUser({ me }: { me: MeIdentity | null }) {
	const { collapsed, peeking } = useSidebar();
	const compact = collapsed && !peeking;
	const name = me ? displayName(me) : "Giraffe";
	const email = me?.email ?? `v${APP_VERSION}`;
	const avatar = (
		<Avatar className="h-9 w-9 shrink-0">
			<AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
		</Avatar>
	);
	if (compact) {
		return (
			<SidebarFooter className="flex w-full justify-center px-0">
				<Tooltip delayDuration={0}>
					<TooltipTrigger asChild>
						<span className="inline-flex">{avatar}</span>
					</TooltipTrigger>
					<TooltipContent side="right" sideOffset={8}>
						{name}
					</TooltipContent>
				</Tooltip>
			</SidebarFooter>
		);
	}
	return (
		<SidebarFooter>
			<SidebarUser name={name} email={email} avatar={avatar} />
		</SidebarFooter>
	);
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate();
	const items = paletteItems(cachedRepoRows());
	const navItems = items.filter((item) => !item.href.startsWith("/repos/"));
	const repoItems = items.filter((item) => item.href.startsWith("/repos/"));
	return (
		<CommandPalette open={open} onOpenChange={onOpenChange}>
			<CommandInput placeholder="搜索页面或仓库" />
			<CommandList>
				<CommandEmpty>没有匹配项</CommandEmpty>
				<CommandGroup heading="导航">
					{navItems.map((item) => (
						<CommandItem
							key={item.href}
							value={`${item.label} ${item.href}`}
							className="cursor-pointer gap-3"
							onSelect={() => {
								onOpenChange(false);
								navigate(item.href);
							}}
						>
							<NavIcon name={item.icon} className="h-4 w-4 text-basalt-muted-foreground" />
							<span>{item.label}</span>
						</CommandItem>
					))}
				</CommandGroup>
				{repoItems.length > 0 ? (
					<CommandGroup heading="仓库">
						{repoItems.map((item) => (
							<CommandItem
								key={item.href}
								value={`${item.label} ${item.href}`}
								className="cursor-pointer gap-3"
								onSelect={() => {
									onOpenChange(false);
									navigate(item.href);
								}}
							>
								<NavIcon name={item.icon} className="h-4 w-4 text-basalt-muted-foreground" />
								<span>{item.label}</span>
							</CommandItem>
						))}
					</CommandGroup>
				) : null}
			</CommandList>
		</CommandPalette>
	);
}

function SearchTrigger({ onSearch }: { onSearch: () => void }) {
	const { collapsed, peeking } = useSidebar();
	const compact = collapsed && !peeking;
	if (compact) {
		return (
			<Tooltip delayDuration={0}>
				<TooltipTrigger asChild>
					<SidebarIconItem className="mb-2" aria-label="搜索 (⌘K)" onClick={onSearch}>
						<Search className="h-4 w-4" strokeWidth={1.5} />
					</SidebarIconItem>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					搜索 (⌘K)
				</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<div className="px-3 pb-1">
			<SidebarSearch onClick={onSearch}>搜索</SidebarSearch>
		</div>
	);
}

function Rail({ onSearch }: { onSearch: () => void }) {
	const { collapsed, peeking } = useSidebar();
	const compact = collapsed && !peeking;
	const [me, setMe] = useState<MeIdentity | null>(null);
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
		<Sidebar>
			{compact ? (
				<div className="flex h-screen w-[68px] flex-col items-center">
					<HeaderBrand />
					<CollapseButton />
					<SearchTrigger onSearch={onSearch} />
					<SideNav />
					<FooterUser me={me} />
				</div>
			) : (
				<div className="flex h-screen flex-col">
					<HeaderBrand />
					<SearchTrigger onSearch={onSearch} />
					<SideNav />
					<FooterUser me={me} />
				</div>
			)}
		</Sidebar>
	);
}

export function AppShell() {
	const location = useLocation();
	const navigate = useNavigate();
	const { overlay, collapsed, setCollapsed } = useShellMedia();
	const crumbs = headerCrumbs(location.pathname);
	const title = headerTitle(location.pathname);
	const [accessDenied, setAccessDenied] = useState(false);
	const [accountMissing, setAccountMissing] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if ((event.metaKey || event.ctrlKey) && event.key === "k") {
				event.preventDefault();
				setSearchOpen((current) => !current);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	useEffect(() => {
		return subscribeErrorUi((ui) => {
			if (ui.kind === "access") {
				setAccessDenied(true);
			}
			if (ui.kind === "account_missing") {
				setAccountMissing(true);
			}
			if (ui.kind === "ok") {
				setAccessDenied(false);
				setAccountMissing(false);
			}
		});
	}, []);
	// Close the mobile overlay when the route changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
	useEffect(() => {
		if (overlay) {
			setCollapsed(true);
		}
	}, [location.pathname, overlay, setCollapsed]);
	return (
		<SidebarProvider
			defaultWidth={260}
			peek={!overlay}
			overlay={overlay}
			collapsed={collapsed}
			onCollapsedChange={setCollapsed}
		>
			<Shell>
				<AppSkipLink>跳到主内容</AppSkipLink>
				<Rail onSearch={() => setSearchOpen(true)} />
				<Palette open={searchOpen} onOpenChange={setSearchOpen} />
				<AppMain tabIndex={-1}>
					<AppHeader
						leading={
							overlay ? (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-8 w-8"
									aria-label="打开导航"
									onClick={() => setCollapsed(false)}
								>
									<Menu aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
								</Button>
							) : null
						}
						{...(crumbs.length > 0 ? { breadcrumbs: crumbs } : {})}
						title={title}
						actions={<ThemeToggle aria-label="切换主题" />}
					/>
					<div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
						<ContentIsland>
							{accessDenied ? (
								<Empty
									icon={<ShieldAlert />}
									title="未通过 Access"
									description="此应用需要 Cloudflare Access 身份。"
								/>
							) : (
								<>
									{accountMissing ? (
										<Banner
											className="mb-4"
											variant="alert"
											title="没有活跃账号"
											action={
												<Banner.Action type="button" onClick={() => navigate("/settings")}>
													去设置
												</Banner.Action>
											}
										/>
									) : null}
									<Outlet />
								</>
							)}
						</ContentIsland>
					</div>
				</AppMain>
			</Shell>
		</SidebarProvider>
	);
}

function useShellMedia(): {
	overlay: boolean;
	collapsed: boolean;
	setCollapsed: (next: boolean) => void;
} {
	const [overlay, setOverlay] = useState(
		() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
	);
	const [collapsed, setCollapsed] = useState(overlay);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 767px)");
		const apply = () => {
			const next = mq.matches;
			setOverlay(next);
			if (next) {
				setCollapsed(true);
			}
		};
		apply();
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, []);
	return { overlay, collapsed, setCollapsed };
}
