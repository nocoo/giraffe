import type { ReactNode } from "react";
import { HelpTooltip } from "./help-tooltip";
import { RepositoryScopeFilter } from "./repository-scope";

export function BusinessPageHeader({
	title,
	description,
	meta,
	actions,
	filters,
	repositoryScope = true,
}: {
	title: ReactNode;
	description?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	filters?: ReactNode;
	repositoryScope?: boolean;
}) {
	return (
		<header className="giraffe-page-header">
			<div className="giraffe-page-heading">
				<h1 className="giraffe-page-title">{title}</h1>
				{description ? (
					<HelpTooltip
						label={typeof title === "string" ? `${title}说明` : "页面说明"}
						className="self-center"
					>
						{description}
					</HelpTooltip>
				) : null}
			</div>
			<div className="giraffe-page-toolbar">
				{meta}
				{repositoryScope ? <RepositoryScopeFilter /> : null}
				{filters}
				{actions}
			</div>
		</header>
	);
}
