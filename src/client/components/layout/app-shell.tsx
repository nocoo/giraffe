import { Button, ContentIsland, Sheet, SheetContent, SheetTitle } from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";
import { Banner } from "@nocoo/basalt/components/banner";
import { Empty } from "@nocoo/basalt/components/empty";
import { ThemeToggle } from "@nocoo/basalt/components/theme-toggle";
import { useTheme } from "@nocoo/basalt/providers/theme";
import { Menu, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { subscribeErrorUi } from "../../lib/error-ui";
import { headerCrumbs, headerTitle } from "../../lib/navigation";
import { AppSidebar } from "./app-sidebar";
import { useIsMobile } from "./use-mobile";

export function AppShell() {
	const [collapsed, setCollapsed] = useState(false);
	const isMobile = useIsMobile();
	const [mobileOpen, setMobileOpen] = useState(false);
	const location = useLocation();
	const navigate = useNavigate();
	const { theme } = useTheme();
	const title = headerTitle(location.pathname);
	const crumbs = headerCrumbs(location.pathname);
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

	// Close mobile sidebar on route change: pathname is the intentional trigger.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a value used inside
	useEffect(() => {
		setMobileOpen(false);
	}, [location.pathname]);

	useEffect(() => {
		document.body.style.overflow = mobileOpen ? "hidden" : "";
		return () => {
			document.body.style.overflow = "";
		};
	}, [mobileOpen]);

	return (
		<Shell>
			<AppSkipLink>跳到主内容</AppSkipLink>
			{!isMobile ? (
				<AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
			) : (
				<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
					<SheetContent
						side="left"
						className="w-[260px] max-w-[260px] border-0 bg-basalt-background p-0"
					>
						<SheetTitle className="sr-only">打开导航</SheetTitle>
						<AppSidebar collapsed={false} onToggle={() => setMobileOpen(false)} />
					</SheetContent>
				</Sheet>
			)}
			<AppMain tabIndex={-1}>
				<AppHeader
					leading={
						isMobile ? (
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={() => setMobileOpen(true)}
								aria-label="打开导航"
							>
								<Menu aria-hidden="true" />
							</Button>
						) : null
					}
					breadcrumbs={crumbs}
					title={title}
					actions={<ThemeToggle aria-label={`切换主题（当前 ${theme}）`} />}
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
	);
}
