import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Sidebar as BasaltSidebar,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPalette,
	Link,
	SidebarBrand,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarIconItem,
	SidebarItem,
	SidebarNav,
	SidebarProvider,
	SidebarSearch,
	SidebarToggle,
	SidebarUser,
	toast,
} from "@nocoo/basalt";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@nocoo/basalt/components/tooltip";
import {
	Activity,
	Box,
	CalendarDays,
	CircleDot,
	Factory,
	GitPullRequest,
	Inbox,
	type LucideIcon,
	RefreshCw,
	Settings,
	ShieldAlert,
	Workflow,
	Wrench,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { APP_VERSION } from "../../../lib/version";
import { ACCESS_LOGOUT_URL } from "../../lib/access";
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

const SIDEBAR_COLLAPSED_KEY = "giraffe:sidebar-collapsed";
type SidebarCollapsedPreference = "false" | "true";

function NavIcon({ name, className }: { name: string; className?: string }) {
	const Icon = ICONS[name] ?? Box;
	return <Icon className={className ?? "h-4 w-4 shrink-0"} strokeWidth={1.5} aria-hidden="true" />;
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

function usePersistedSidebarCollapsed(
	key: string,
	defaultValue: SidebarCollapsedPreference,
): [SidebarCollapsedPreference, (value: SidebarCollapsedPreference) => void] {
	const [stored, setStored] = useState<SidebarCollapsedPreference>(() => {
		if (typeof window === "undefined") return defaultValue;
		const value = localStorage.getItem(key);
		return value === "true" || value === "false" ? value : defaultValue;
	});

	const setValue = useCallback(
		(next: SidebarCollapsedPreference) => {
			setStored(next);
			localStorage.setItem(key, next);
		},
		[key],
	);

	return [stored, setValue];
}

export function PersistedSidebarProvider({ children }: { children: ReactNode }) {
	const [stored, setStored] = usePersistedSidebarCollapsed(SIDEBAR_COLLAPSED_KEY, "false");
	const collapsed = stored === "true";
	const onCollapsedChange = useCallback(
		(next: boolean) => {
			setStored(next ? "true" : "false");
		},
		[setStored],
	);

	return (
		<SidebarProvider collapsed={collapsed} onCollapsedChange={onCollapsedChange} defaultWidth={260}>
			{children}
		</SidebarProvider>
	);
}

interface SidebarProps {
	/** Accessible name for the complementary landmark. */
	ariaLabel: string;
	variant?: "desktop" | "mobile";
	onNavigate?: () => void;
	onDismiss?: () => void;
}

function GiraffeSidebarBody({
	variant,
	onNavigate,
	onDismiss,
}: {
	variant?: SidebarProps["variant"];
	onNavigate?: () => void;
	onDismiss?: () => void;
}) {
	const project = useProjectIdentity("nocoo/giraffe");
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const { collapsed, peek, peeking } = useSidebar();
	const railCollapsed = collapsed && !(peek && peeking);
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
		<Avatar>
			{me?.avatar ? <AvatarImage src={me.avatar} alt={name} /> : null}
			<AvatarFallback>{initials(name)}</AvatarFallback>
		</Avatar>
	);

	const brandTitle = project?.title ?? "Giraffe";
	const brandLogo = (
		<Link
			href="/"
			aria-label="Giraffe 首页"
			className="text-basalt-foreground no-underline hover:no-underline"
		>
			<BrandMark size={24} alt="" />
		</Link>
	);

	return (
		<>
			<SidebarHeader>
				<SidebarBrand
					logo={brandLogo}
					name={brandTitle}
					version={`v${APP_VERSION}`}
					action={
						variant === "mobile" ? (
							<SidebarToggle
								mode="dismiss"
								dismissLabel="关闭导航菜单"
								{...(onDismiss ? { onDismiss } : {})}
							/>
						) : (
							<SidebarToggle expandLabel="展开侧栏" collapseLabel="折叠侧栏" />
						)
					}
				/>
			</SidebarHeader>
			<SidebarNav aria-label="主导航">
				<SidebarSearch shortcut="⌘K" data-sidebar-search-trigger="true" onClick={openSearch}>
					搜索
				</SidebarSearch>
				{railCollapsed
					? NAV_ITEMS.map((item) => {
							const active = navActive(pathname, item.href);
							return (
								<Tooltip key={item.href} delayDuration={0}>
									<TooltipTrigger asChild>
										<SidebarIconItem
											href={item.href}
											active={active}
											aria-label={item.label}
											onClick={onNavigate}
										>
											<NavIcon name={item.icon} />
										</SidebarIconItem>
									</TooltipTrigger>
									<TooltipContent side="right" sideOffset={8}>
										{item.label}
									</TooltipContent>
								</Tooltip>
							);
						})
					: NAV_GROUPS.map((group) => (
							<SidebarGroup key={group.label} label={group.label}>
								{group.items.map((item) => (
									<SidebarItem
										key={item.href}
										href={item.href}
										active={navActive(pathname, item.href)}
										onClick={onNavigate}
									>
										<NavIcon name={item.icon} />
										<span className="flex-1 truncate text-left">{item.label}</span>
									</SidebarItem>
								))}
							</SidebarGroup>
						))}
			</SidebarNav>
			<SidebarFooter>
				<SidebarUser
					name={name}
					email={email}
					avatar={avatar}
					tooltip={name}
					signOutHref={ACCESS_LOGOUT_URL}
					signOutLabel="退出登录"
				/>
			</SidebarFooter>
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
									<NavIcon name={item.icon} className="text-basalt-muted-foreground" />
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
		</>
	);
}

export function AppSidebar({
	ariaLabel,
	variant = "desktop",
	onNavigate,
	onDismiss,
}: SidebarProps) {
	return (
		<TooltipProvider delayDuration={0}>
			<BasaltSidebar aria-label={ariaLabel} resizable={false}>
				<GiraffeSidebarBody
					variant={variant}
					{...(onNavigate ? { onNavigate } : {})}
					{...(onDismiss ? { onDismiss } : {})}
				/>
			</BasaltSidebar>
		</TooltipProvider>
	);
}
