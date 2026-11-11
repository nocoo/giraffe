import { ContentIsland } from "@nocoo/basalt";
import { AppHeader, AppHeaderMenuButton, ProjectLinks } from "@nocoo/basalt/components/app-header";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";
import { Banner } from "@nocoo/basalt/components/banner";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@nocoo/basalt/components/sheet";
import { SidebarProvider } from "@nocoo/basalt/components/sidebar";
import { ThemeToggle } from "@nocoo/basalt/components/theme-toggle";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { subscribeErrorUi } from "../../lib/error-ui";
import { breadcrumbsFor, documentTitle, headerTitle } from "../../lib/navigation";
import { AppSidebar, PersistedSidebarProvider } from "./app-sidebar";
import { DataTimeControl, DataTimeProvider } from "./data-time";
import { EmptyState } from "./empty-state";
import { EnvironmentSwitch } from "./environment-switch";
import { MobileNavProvider, useMobileNav } from "./mobile-nav-context";
import { RefreshControl } from "./refresh-control";
import { useRepositoryScope } from "./repository-scope";
import { useIsMobile } from "./use-mobile";
import { useProjectIdentity } from "./use-project-identity";

function AppShellInner() {
	const project = useProjectIdentity("nocoo/giraffe");
	useEffect(() => {
		if (!project) return;
		const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (favicon) {
			const image = new Image();
			image.onload = () => {
				favicon.href = project.favicon;
				favicon.removeAttribute("type");
			};
			image.onerror = () => {
				favicon.href = "/logo-32.png";
			};
			image.src = project.favicon;
			return () => {
				image.onload = null;
				image.onerror = null;
			};
		}
	}, [project]);

	const isMobile = useIsMobile();
	const { mobileOpen, setMobileOpen } = useMobileNav();
	const menuButton = useRef<HTMLButtonElement>(null);
	const location = useLocation();

	useEffect(() => {
		document.title = documentTitle(location.pathname);
	}, [location.pathname]);

	// Close mobile sidebar on route change: pathname is the intentional trigger.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a value used inside
	useEffect(() => {
		setMobileOpen(false);
	}, [location.pathname]);

	useEffect(() => {
		if (!isMobile) setMobileOpen(false);
	}, [isMobile, setMobileOpen]);

	const scope = useRepositoryScope();
	const navigate = useNavigate();
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
			if (ui.kind === "ok") {
				setAccessDenied(false);
				setAccountMissing(false);
			}
		});
	}, []);

	function appHeaderBreadcrumbs(pathname: string) {
		const crumbs = breadcrumbsFor(pathname);
		const trail: { href?: string; label: string }[] = [{ label: "Giraffe", href: "/" }];
		if (crumbs.length > 1) {
			trail.push(...crumbs.slice(0, -1));
		}
		trail.push({ label: headerTitle(pathname) });
		return trail;
	}
	const breadcrumbs = isMobile
		? appHeaderBreadcrumbs(location.pathname).slice(-1)
		: appHeaderBreadcrumbs(location.pathname);

	return (
		<Shell>
			<AppSkipLink>跳到主内容</AppSkipLink>
			{!isMobile ? (
				<PersistedSidebarProvider>
					<AppSidebar ariaLabel="主导航" />
				</PersistedSidebarProvider>
			) : (
				<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
					<SheetContent
						id="mobile-navigation-sheet"
						side="left"
						className="w-[260px] max-w-[260px] border-0 bg-basalt-background p-0 sm:max-w-[260px] sm:p-0"
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							menuButton.current?.focus();
						}}
					>
						<SheetHeader className="sr-only">
							<SheetTitle>导航菜单</SheetTitle>
							<SheetDescription>浏览 Giraffe 的主要页面</SheetDescription>
						</SheetHeader>
						<SidebarProvider collapsed={false} defaultWidth={260}>
							<AppSidebar
								ariaLabel="主导航抽屉"
								variant="mobile"
								onNavigate={() => setMobileOpen(false)}
								onDismiss={() => setMobileOpen(false)}
							/>
						</SidebarProvider>
					</SheetContent>
				</Sheet>
			)}
			<DataTimeProvider scope={`${location.pathname}:${scope}`}>
				<AppMain tabIndex={-1}>
					<AppHeader
						leading={
							isMobile ? (
								<AppHeaderMenuButton
									ref={menuButton}
									label="打开导航"
									aria-expanded={mobileOpen}
									aria-haspopup="dialog"
									aria-controls={mobileOpen ? "mobile-navigation-sheet" : undefined}
									onClick={() => setMobileOpen(true)}
								/>
							) : null
						}
						breadcrumbs={breadcrumbs}
						breadcrumbsLabel="面包屑导航"
						actions={
							<>
								<EnvironmentSwitch />
								<RefreshControl />
								{location.pathname !== "/settings" ? (
									<DataTimeControl key={`${location.pathname}:${scope}`} />
								) : null}
								<ProjectLinks
									github="nocoo/giraffe"
									hexly="giraffe"
									name="Giraffe"
									githubLabel="GitHub repository"
									hexlyLabel="Giraffe on hexly.ai"
								/>
								<ThemeToggle
									labels={{
										light: "切换为浅色主题",
										dark: "切换为深色主题",
										system: "跟随系统主题",
									}}
								/>
							</>
						}
					/>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col px-basalt-space-lg pb-basalt-space-lg md:px-basalt-layout-sm md:pb-basalt-layout-sm">
						<ContentIsland>
							{accessDenied ? (
								<div className="space-y-8">
									<PageHeader
										title="未通过 Access"
										description="此应用需要 Cloudflare Access 身份。"
									/>
									<LayerCard>
										<LayerCard.Body>
											<EmptyState
												icon={<ShieldAlert />}
												title="未通过 Access"
												description="此应用需要 Cloudflare Access 身份。"
											/>
										</LayerCard.Body>
									</LayerCard>
								</div>
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
									<Outlet key={location.pathname} />
								</>
							)}
						</ContentIsland>
					</div>
				</AppMain>
			</DataTimeProvider>
		</Shell>
	);
}

export function AppShell() {
	return (
		<MobileNavProvider>
			<AppShellInner />
		</MobileNavProvider>
	);
}
