import { LinkProvider, ThemeProvider, Toaster, TooltipProvider } from "@nocoo/basalt";
import { AccentProvider } from "@nocoo/basalt/providers/accent";
import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/app-shell";
import { APP_PATHS } from "./lib/routes";

const AlertsPage = lazy(() => import("./routes/alerts").then((m) => ({ default: m.AlertsPage })));
const CiPage = lazy(() => import("./routes/ci").then((m) => ({ default: m.CiPage })));
const DigestPage = lazy(() => import("./routes/digest").then((m) => ({ default: m.DigestPage })));
const FactoryPage = lazy(() =>
	import("./routes/factory").then((m) => ({ default: m.FactoryPage })),
);
const InboxPage = lazy(() => import("./routes/inbox").then((m) => ({ default: m.InboxPage })));
const InsightsPage = lazy(() =>
	import("./routes/insights").then((m) => ({ default: m.InsightsPage })),
);
const IssuesPage = lazy(() => import("./routes/issues").then((m) => ({ default: m.IssuesPage })));
const NotFoundPage = lazy(() =>
	import("./routes/not-found").then((m) => ({ default: m.NotFoundPage })),
);
const PullsPage = lazy(() => import("./routes/pulls").then((m) => ({ default: m.PullsPage })));
const RepoDetailPage = lazy(() =>
	import("./routes/repo-detail").then((m) => ({ default: m.RepoDetailPage })),
);
const ReposPage = lazy(() => import("./routes/repos").then((m) => ({ default: m.ReposPage })));
const SettingsPage = lazy(() =>
	import("./routes/settings").then((m) => ({ default: m.SettingsPage })),
);

function RouterLink({
	href,
	className,
	children,
	...props
}: {
	href: string;
	className?: string;
	children?: ReactNode;
} & Record<string, unknown>) {
	if (/^(https?:|mailto:|tel:)/.test(href)) {
		return (
			<a href={href} className={className} {...props}>
				{children}
			</a>
		);
	}
	if (className === undefined) {
		return <Link to={href}>{children}</Link>;
	}
	return (
		<Link to={href} className={className}>
			{children}
		</Link>
	);
}

const PAGES: Record<(typeof APP_PATHS)[number], ReactNode> = {
	"/": <ReposPage />,
	"/factory": <FactoryPage />,
	"/issues": <IssuesPage />,
	"/pulls": <PullsPage />,
	"/insights": <InsightsPage />,
	"/ci": <CiPage />,
	"/alerts": <AlertsPage />,
	"/inbox": <InboxPage />,
	"/digest": <DigestPage />,
	"/repos/:owner/:name": <RepoDetailPage />,
	"/settings": <SettingsPage />,
};

export function App() {
	return (
		<ThemeProvider>
			<AccentProvider defaultAccent="green" persist={false}>
				<LinkProvider render={RouterLink}>
					<TooltipProvider>
						<BrowserRouter>
							<Toaster />
							<Routes>
								<Route element={<AppShell />}>
									{APP_PATHS.map((path) => (
										<Route
											key={path}
											path={path}
											element={
												<Suspense
													fallback={
														<p role="status" className="p-4 text-sm text-basalt-muted-foreground">
															正在加载页面…
														</p>
													}
												>
													{PAGES[path]}
												</Suspense>
											}
										/>
									))}
									<Route
										path="*"
										element={
											<Suspense fallback={null}>
												<NotFoundPage />
											</Suspense>
										}
									/>
								</Route>
							</Routes>
						</BrowserRouter>
					</TooltipProvider>
				</LinkProvider>
			</AccentProvider>
		</ThemeProvider>
	);
}
