import { PageHeader, type PageHeaderProps } from "@nocoo/basalt/components/page-header";
import { RepositoryScopeFilter } from "./repository-scope";

export function BusinessPageHeader({ title, actions, filters, ...props }: PageHeaderProps) {
	return (
		<PageHeader
			{...props}
			title={<span className="giraffe-page-title">{title}</span>}
			actions={
				<>
					<div className="giraffe-page-controls">
						<RepositoryScopeFilter />
						{actions}
					</div>
					{filters ? <div className="giraffe-page-filters">{filters}</div> : null}
				</>
			}
		/>
	);
}
