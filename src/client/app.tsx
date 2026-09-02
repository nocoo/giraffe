import { LinkProvider, ThemeProvider, Toaster } from "@nocoo/basalt";
import type { ReactNode } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/app-shell";
import { AlertsPage } from "./routes/alerts";
import { DigestPage } from "./routes/digest";
import { InboxPage } from "./routes/inbox";
import { InsightsPage } from "./routes/insights";
import { IssuesPage } from "./routes/issues";
import { PullsPage } from "./routes/pulls";
import { ReposPage } from "./routes/repos";
import { SettingsPage } from "./routes/settings";

function RouterLink({
	href,
	className,
	children,
}: {
	href: string;
	className?: string;
	children?: ReactNode;
}) {
	if (className === undefined) {
		return <Link to={href}>{children}</Link>;
	}
	return (
		<Link to={href} className={className}>
			{children}
		</Link>
	);
}

export function App() {
	return (
		<ThemeProvider>
			<LinkProvider render={RouterLink}>
				<BrowserRouter>
					<Toaster />
					<Routes>
						<Route element={<AppShell />}>
							<Route path="/" element={<ReposPage />} />
							<Route path="/issues" element={<IssuesPage />} />
							<Route path="/pulls" element={<PullsPage />} />
							<Route path="/insights" element={<InsightsPage />} />
							<Route path="/alerts" element={<AlertsPage />} />
							<Route path="/inbox" element={<InboxPage />} />
							<Route path="/digest" element={<DigestPage />} />
							<Route path="/settings" element={<SettingsPage />} />
						</Route>
					</Routes>
				</BrowserRouter>
			</LinkProvider>
		</ThemeProvider>
	);
}
