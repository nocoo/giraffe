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
	Sidebar,
	SidebarFooter,
	SidebarHeader,
	SidebarIconItem,
	SidebarItem,
	SidebarNav,
	SidebarPartition,
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
	CircleDot,
	GitPullRequest,
	Inbox,
	type LucideIcon,
	Newspaper,
	PanelLeft,
	Search,
	Settings,
	ShieldAlert,
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

function commandSearchMatches(value: string, query: string) {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const normalizedValue = value.toLocaleLowerCase();
	return tokens.every((token) => normalizedValue.includes(token));
}

export function AppSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if ((event.metaKey || event.ctrlKey) && event.key === "k") {
				event.preventDefault();
				handleSearchOpenChange(!searchOpen);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [handleSearchOpenChange, searchOpen]);

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
	const email = me?.email ?? `v${APP_VERSION}`;
	const avatar = (
		<Avatar className="h-9 w-9 shrink-0">
			{me?.avatar ? <AvatarImage src={me.avatar} alt={name} /> : null}
			<AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
		</Avatar>
	);

	return (
		<Sidebar collapsed={collapsed}>
			{collapsed ? (
				<>
					<SidebarHeader className="justify-center px-0">
						<BrandMark alt="Giraffe" />
					</SidebarHeader>
					<Button
						variant="ghost"
						size="icon"
						className="mb-1 self-center"
						onClick={onToggle}
						aria-label="展开侧栏"
					>
						<PanelLeft aria-hidden="true" />
					</Button>
					<Tooltip delayDuration={0}>
						<TooltipTrigger asChild>
							<SidebarIconItem
								className="mb-2 self-center"
								onClick={() => setSearchOpen(true)}
								aria-label="搜索 (⌘K)"
							>
								<Search className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
							</SidebarIconItem>
						</TooltipTrigger>
						<TooltipContent side="right" sideOffset={8}>
							搜索 (⌘K)
						</TooltipContent>
					</Tooltip>
					<SidebarNav className="w-full items-center gap-1 pt-1">
						{NAV_ITEMS.map((item) => (
							<Tooltip key={item.href} delayDuration={0}>
								<TooltipTrigger asChild>
									<SidebarIconItem
										active={navActive(pathname, item.href)}
										aria-label={item.label}
										className="self-center"
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
				</>
			) : (
				<>
					<SidebarHeader>
						<div className="flex w-full items-center justify-between">
							<div className="flex min-w-0 items-center gap-3">
								<BrandMark />
								<span className="truncate text-lg font-semibold text-basalt-foreground md:text-xl">
									Giraffe
								</span>
								<span className="shrink-0 rounded-md bg-basalt-secondary px-1.5 py-0.5 text-[10px] leading-none font-medium text-basalt-muted-foreground">
									v{APP_VERSION}
								</span>
							</div>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 shrink-0"
								onClick={onToggle}
								aria-label="折叠侧栏"
							>
								<PanelLeft aria-hidden="true" />
							</Button>
						</div>
					</SidebarHeader>
					<div className="px-3 pb-1">
						<SidebarSearch onClick={() => setSearchOpen(true)}>搜索</SidebarSearch>
					</div>
					<SidebarNav className="pt-1">
						{NAV_GROUPS.map((group) => (
							<div key={group.label}>
								<SidebarPartition>{group.label}</SidebarPartition>
								<div className="flex flex-col gap-0.5 px-3">
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
								</div>
							</div>
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
									className="cursor-pointer gap-3"
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
									className="cursor-pointer gap-3"
								>
									<NavIcon name={item.icon} className="h-4 w-4 text-basalt-muted-foreground" />
									<span>{item.label}</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
				</CommandList>
			</CommandPalette>
		</Sidebar>
	);
}
