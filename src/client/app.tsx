import { LinkProvider, ThemeProvider, Toaster, TooltipProvider } from "@nocoo/basalt";
import type { ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/app-shell";
import { APP_PATHS } from "./lib/routes";
import { AlertsPage } from "./routes/alerts";
import { DigestPage } from "./routes/digest";
import { InboxPage } from "./routes/inbox";
import { InsightsPage } from "./routes/insights";
import { IssuesPage } from "./routes/issues";
import { NotFoundPage } from "./routes/not-found";
import { PullsPage } from "./routes/pulls";
import { RepoDetailPage } from "./routes/repo-detail";
import { ReposPage } from "./routes/repos";
import { SettingsPage } from "./routes/settings";

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
	if (href.startsWith("https://") || href.startsWith("http://")) {
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
	"/issues": <IssuesPage />,
	"/pulls": <PullsPage />,
	"/insights": <InsightsPage />,
	"/alerts": <AlertsPage />,
	"/inbox": <InboxPage />,
	"/digest": <DigestPage />,
	"/repos/:owner/:name": <RepoDetailPage />,
	"/settings": <SettingsPage />,
};

export function App() {
	return (
		<ThemeProvider>
			<LinkProvider render={RouterLink}>
				<TooltipProvider>
					<BrowserRouter>
						<Toaster />
						<Routes>
							<Route element={<AppShell />}>
								{APP_PATHS.map((path) => (
									<Route key={path} path={path} element={PAGES[path]} />
								))}
								<Route path="*" element={<NotFoundPage />} />
							</Route>
						</Routes>
					</BrowserRouter>
				</TooltipProvider>
			</LinkProvider>
		</ThemeProvider>
	);
}
