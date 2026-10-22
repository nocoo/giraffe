import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPalette,
	Link,
	Sidebar,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarIconItem,
	SidebarItem,
	SidebarNav,
	SidebarSearch,
	SidebarUser,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	toast,
} from "@nocoo/basalt";
import {
	Activity,
	Box,
	CalendarDays,
	CircleDot,
	Factory,
	GitPullRequest,
	Inbox,
	type LucideIcon,
	PanelLeft,
	RefreshCw,
	Search,
	Settings,
	ShieldAlert,
	Workflow,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { APP_VERSION } from "../../../lib/version";
import { reportError } from "../../lib/error-ui";
import { initials } from "../../lib/format";
import { NAV_GROUPS, NAV_ITEMS, paletteItems } from "../../lib/navigation";
import { displayName, loadMe, type MeIdentity } from "../../viewmodels/me";
import { cachedRepoRows } from "../../viewmodels/repos";
import { BrandMark } from "./mark";
import { ProjectLabel } from "./project-identity";
import { useProjectIdentity } from "./use-project-identity";

const ICONS: Record<string, LucideIcon> = {
	CalendarDays,
	Factory,
	Box,
	CircleDot,
	GitPullRequest,
	Activity,
	ShieldAlert,
	Inbox,
	RefreshCw,
	Settings,
	Workflow,
	Wrench,
};

function NavIcon({ name, className }: { name: string; className?: string }) {
	const Icon = ICONS[name] ?? Box;
	return <Icon className={className ?? "h-4 w-4 shrink-0"} strokeWidth={1.5} />;
}

function navActive(pathname: string, href: string): boolean {
	if (href === "/repos") {
		return pathname === "/repos" || pathname.startsWith("/repos/");
	}
	return pathname === href;
}

function commandSearchMatches(value: string, query: string) {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const normalizedValue = value.toLocaleLowerCase();
	return tokens.every((token) => normalizedValue.includes(token));
}

export function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
	const project = useProjectIdentity("nocoo/giraffe");
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [me, setMe] = useState<MeIdentity | null>(null);
	const handleSearchOpenChange = useCallback((open: boolean) => {
		setSearchOpen(open);
		if (!open) {
			setSearchQuery("");
		}
	}, []);

	const openSearch = useCallback(() => {
		setSearchQuery("");
		setSearchOpen(true);
	}, []);

	useEffect(() => {
		function isShortcut(event: KeyboardEvent) {
			return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
		}
		function onKeyDown(event: KeyboardEvent) {
			if (!isShortcut(event)) return;
			event.preventDefault();
			window.setTimeout(() => {
				const trigger = document.querySelector<HTMLElement>('[data-sidebar-search-trigger="true"]');
				if (trigger) {
					trigger.click();
					return;
				}
				openSearch();
			}, 0);
		}
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [openSearch]);

	useEffect(() => {
		void loadMe()
			.then(setMe)
			.catch((err: unknown) => {
				const ui = reportError(err);
				if (ui.kind === "toast") {
					toast.error(ui.message);
				}
			});
	}, []);

	const handleSelect = useCallback(
		(href: string) => {
			handleSearchOpenChange(false);
			navigate(href);
		},
		[handleSearchOpenChange, navigate],
	);

	const items = paletteItems(cachedRepoRows());
	const navItems = items.filter(
		(item) => !item.href.startsWith("/repos/") && commandSearchMatches(item.label, searchQuery),
	);
	const repoItems = items.filter(
		(item) => item.href.startsWith("/repos/") && commandSearchMatches(item.label, searchQuery),
	);
	const name = me ? displayName(me) : "Giraffe";
	const email = me?.email;
	const avatar = (
		<Avatar className="h-9 w-9 shrink-0">
			{me?.avatar ? <AvatarImage src={me.avatar} alt={name} /> : null}
			<AvatarFallback className="text-basalt-sm">{initials(name)}</AvatarFallback>
		</Avatar>
	);

	return (
		<Sidebar collapsed={collapsed}>
			<SidebarHeader>
				<div
					className={`flex w-full items-center ${collapsed ? "justify-center" : "justify-between pl-basalt-layout-sm"}`}
				>
					<Link
						href="/"
						aria-label="Giraffe 首页"
						className="flex min-w-0 items-center gap-basalt-space-lg text-basalt-foreground no-underline hover:no-underline"
					>
						<BrandMark />
						{collapsed ? null : (
							<>
								<span className="truncate text-basalt-xl font-semibold text-basalt-foreground md:text-basalt-2xl">
									{project?.title ?? "Giraffe"}
								</span>
								<span className="shrink-0 rounded-basalt-md bg-basalt-secondary px-basalt-space-md py-basalt-space-xs font-mono text-basalt-xs leading-basalt-tight font-medium text-basalt-muted-foreground">
									v{APP_VERSION}
								</span>
							</>
						)}
					</Link>
					{collapsed ? null : (
						<Button
							variant="ghost"
							size="icon"
							className="w-7 shrink-0"
							onClick={onToggle}
							aria-label="折叠侧栏"
						>
							<PanelLeft aria-hidden="true" />
						</Button>
					)}
				</div>
			</SidebarHeader>
			{collapsed ? (
				<>
					<Button
						variant="ghost"
						size="icon"
						className="mb-basalt-space-sm self-center"
						onClick={onToggle}
						aria-label="展开侧栏"
					>
						<PanelLeft aria-hidden="true" />
					</Button>
					<SidebarNav>
						<Tooltip delayDuration={0}>
							<TooltipTrigger asChild>
								<SidebarIconItem
									data-sidebar-search-trigger="true"
									onClick={openSearch}
									aria-label="搜索 (⌘K)"
								>
									<Search className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
								</SidebarIconItem>
							</TooltipTrigger>
							<TooltipContent side="right" sideOffset={8}>
								搜索 (⌘K)
							</TooltipContent>
						</Tooltip>
						{NAV_ITEMS.map((item) => (
							<Tooltip key={item.href} delayDuration={0}>
								<TooltipTrigger asChild>
									<SidebarIconItem
										active={navActive(pathname, item.href)}
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
						))}
					</SidebarNav>
					<SidebarFooter>
						<Tooltip delayDuration={0}>
							<TooltipTrigger asChild>
								<span className="inline-flex">{avatar}</span>
							</TooltipTrigger>
							<TooltipContent side="right" sideOffset={8}>
								{name}
							</TooltipContent>
						</Tooltip>
					</SidebarFooter>
				</>
			) : (
				<>
					<div className="px-basalt-nav-inset">
						<SidebarSearch data-sidebar-search-trigger="true" onClick={openSearch}>
							搜索
						</SidebarSearch>
					</div>
					<SidebarNav>
						{NAV_GROUPS.map((group) => (
							<SidebarGroup key={group.label} label={group.label} defaultOpen>
								{group.items.map((item) => (
									<SidebarItem
										key={item.href}
										active={navActive(pathname, item.href)}
										onClick={() => navigate(item.href)}
									>
										<NavIcon name={item.icon} />
										<span className="flex-1 truncate text-left">{item.label}</span>
									</SidebarItem>
								))}
							</SidebarGroup>
						))}
					</SidebarNav>
					<SidebarFooter>
						<SidebarUser name={name} email={email} avatar={avatar} />
					</SidebarFooter>
				</>
			)}
			<CommandPalette open={searchOpen} onOpenChange={handleSearchOpenChange} shouldFilter={false}>
				<CommandInput
					placeholder="搜索页面或仓库"
					value={searchQuery}
					onValueChange={setSearchQuery}
					onInput={(event) => {
						setSearchQuery(event.currentTarget.value);
					}}
				/>
				<CommandList>
					<CommandEmpty>没有匹配项</CommandEmpty>
					{navItems.length > 0 ? (
						<CommandGroup heading="导航">
							{navItems.map((item) => (
								<CommandItem
									key={item.href}
									value={`${item.label} ${item.href}`}
									onSelect={() => handleSelect(item.href)}
									className="cursor-pointer gap-basalt-space-lg"
								>
									<NavIcon name={item.icon} className="h-4 w-4 text-basalt-muted-foreground" />
									<span>{item.label}</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
					{repoItems.length > 0 ? (
						<CommandGroup heading="仓库">
							{repoItems.map((item) => (
								<CommandItem
									key={item.href}
									value={`${item.label} ${item.href}`}
									onSelect={() => handleSelect(item.href)}
									className="cursor-pointer gap-basalt-space-lg"
								>
									<ProjectLabel repo={item.label} />
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
				</CommandList>
			</CommandPalette>
		</Sidebar>
	);
}
