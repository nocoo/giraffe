import type { ReactNode } from "react";
import { RepositoryScopeFilter } from "./repository-scope";

/**
 * Single-row page chrome. Basalt's `PageHeader` gives the description and the
 * filters their own bands; here the description becomes a muted inline suffix
 * and data times, scope, filters and page actions share one toolbar row.
 */
export function BusinessPageHeader({
	title,
	description,
	meta,
	actions,
	filters,
}: {
	title: ReactNode;
	description?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	filters?: ReactNode;
}) {
	return (
		<header className="giraffe-page-header">
			<div className="giraffe-page-heading">
				<h1 className="giraffe-page-title">{title}</h1>
				{description ? (
					<p
						className="giraffe-page-subtitle"
						{...(typeof description === "string" ? { title: description } : {})}
					>
						{description}
					</p>
				) : null}
			</div>
			<div className="giraffe-page-toolbar">
				{meta}
				<RepositoryScopeFilter />
				{filters}
				{actions}
			</div>
		</header>
	);
}
