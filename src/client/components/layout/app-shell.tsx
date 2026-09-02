import { ContentIsland, Sidebar, SidebarHeader, SidebarProvider } from "@nocoo/basalt";
import { AppMain, AppSkipLink, AppShell as Shell } from "@nocoo/basalt/components/app-shell";

export function AppShell() {
	return (
		<SidebarProvider defaultWidth={260}>
			<AppSkipLink>跳到主内容</AppSkipLink>
			<Shell>
				<Sidebar>
					<SidebarHeader>Giraffe</SidebarHeader>
				</Sidebar>
				<AppMain tabIndex={-1}>
					<ContentIsland />
				</AppMain>
			</Shell>
		</SidebarProvider>
	);
}
