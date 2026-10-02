import { Link } from "@nocoo/basalt";
import { Archive, BookOpen, Box, ExternalLink, Globe } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ProjectIdentity } from "../../../lib/project-identity";
import { CandyBadge } from "./candy-badge";
import { useProjectIdentity } from "./use-project-identity";

export function ProjectMark({
	project,
	size = 24,
	navigation = false,
	alt = "",
	fallbackSrc,
}: {
	project: ProjectIdentity | null;
	size?: number;
	navigation?: boolean;
	alt?: string;
	fallbackSrc?: string;
}) {
	const source = project
		? navigation
			? project.navigationIcon
			: size >= 48
				? project.icons.large
				: project.icons.small
		: fallbackSrc;
	const [failed, setFailed] = useState<string>();
	const src = source === failed ? fallbackSrc : source;
	return src ? (
		<img
			src={src}
			alt={alt}
			width={size}
			height={size}
			className="shrink-0 object-contain"
			style={{ width: size, height: size }}
			loading="lazy"
			decoding="async"
			onError={() => setFailed(src)}
		/>
	) : (
		<Box
			aria-hidden="true"
			width={size}
			height={size}
			className="shrink-0 text-basalt-muted-foreground"
			strokeWidth={1.5}
		/>
	);
}

export function ProjectName({
	repo,
	project,
	size = 24,
	showTitle = false,
	short = false,
}: {
	repo: string;
	project: ProjectIdentity | null;
	size?: number;
	showTitle?: boolean;
	short?: boolean;
}) {
	const name = short ? repo.split("/").at(-1) : repo;
	return (
		<span
			className="inline-flex min-w-0 max-w-full items-center gap-2.5 align-middle"
			title={project ? `${project.title} · ${project.description}` : repo}
		>
			<ProjectMark project={project} size={size} />
			<span className={short ? "min-w-0 truncate" : "min-w-0 [overflow-wrap:anywhere]"}>
				<span className={short ? "block truncate" : "block"}>
					{showTitle && project ? project.title : name}
				</span>
				{showTitle && project ? (
					<span className="block text-xs font-normal text-basalt-muted-foreground">{repo}</span>
				) : null}
			</span>
		</span>
	);
}

type LabelProps = {
	repo: string;
	size?: number;
	showTitle?: boolean;
	short?: boolean;
	className?: string;
};

export function ProjectLabel({ repo, className, ...props }: LabelProps) {
	const project = useProjectIdentity(repo);
	return (
		<span className={`inline-flex min-w-0 max-w-full ${className ?? ""}`}>
			<ProjectName repo={repo} project={project} {...props} />
		</span>
	);
}

export function ProjectLink({
	repo,
	className = "font-medium text-basalt-foreground hover:text-basalt-primary",
	...props
}: LabelProps) {
	return (
		<Link href={`/repos/${repo}`} className={className}>
			<ProjectLabel repo={repo} {...props} />
		</Link>
	);
}

export function ProjectLinks({
	project,
	github,
	compact = false,
}: {
	project: ProjectIdentity | null;
	github?: string;
	/** Table rows: icon-only links; the row shows project archival beside the name. */
	compact?: boolean;
}) {
	const destination = project?.github ?? github;
	const links = [
		destination ? { href: destination, label: "GitHub", icon: ExternalLink } : null,
		project?.website ? { href: project.website, label: "访问站点", icon: Globe } : null,
		project ? { href: project.url, label: "项目说明", icon: BookOpen } : null,
	].filter((l) => l !== null);
	return (
		<span
			className={`inline-flex items-center text-xs font-medium ${compact ? "shrink-0 gap-1" : "flex-wrap gap-x-3 gap-y-1.5"}`}
		>
			{links.map(({ href, label, icon: Icon }) => (
				<Link
					key={label}
					href={href}
					target="_blank"
					rel="noreferrer"
					className={compact ? "giraffe-icon-link" : "inline-flex items-center gap-1"}
					{...(compact ? { "aria-label": label, title: label } : {})}
				>
					<Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
					{compact ? null : label}
				</Link>
			))}
			{project?.archived && !compact ? (
				<CandyBadge tone="gray" icon={Archive}>
					项目已归档
				</CandyBadge>
			) : null}
		</span>
	);
}

export function ProjectSummary({
	repo,
	description,
	card = false,
	badges,
}: {
	repo: string;
	description: string | null;
	card?: boolean;
	/** Row state shown beside the name in table rows. */
	badges?: ReactNode;
}) {
	const project = useProjectIdentity(repo);
	const summary = project?.description || description;
	if (card)
		return (
			<div className="min-w-0 flex-1" data-project={repo}>
				<Link
					href={`/repos/${repo}`}
					className="text-base font-semibold text-basalt-foreground hover:text-basalt-primary"
				>
					<ProjectName repo={repo} project={project} showTitle size={48} />
				</Link>
				{summary ? (
					<p
						className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-basalt-muted-foreground"
						title={summary}
					>
						{summary}
					</p>
				) : null}
				{project ? (
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<ProjectLinks project={project} />
					</div>
				) : null}
			</div>
		);
	// Table rows: identity and state on line one; description and links on line two.
	return (
		<div className="giraffe-project-row" data-project={repo}>
			<ProjectMark project={project} size={32} />
			<div className="min-w-0">
				<div className="giraffe-project-row-line">
					<Link
						href={`/repos/${repo}`}
						className="min-w-0 truncate text-sm font-semibold text-basalt-foreground hover:text-basalt-primary"
						title={project ? `${project.title} · ${project.description}` : repo}
					>
						<span>{project ? project.title : repo}</span>
						{project ? (
							<span className="ml-2 text-xs font-normal text-basalt-muted-foreground">{repo}</span>
						) : null}
					</Link>
					{project?.archived ? (
						<CandyBadge tone="gray" icon={Archive}>
							项目已归档
						</CandyBadge>
					) : null}
					{badges}
				</div>
				<div className="giraffe-project-row-line text-xs leading-5">
					<p
						className="min-w-0 flex-1 truncate text-basalt-muted-foreground"
						title={summary ?? undefined}
					>
						{summary}
					</p>
					{project ? <ProjectLinks project={project} compact /> : null}
				</div>
			</div>
		</div>
	);
}
