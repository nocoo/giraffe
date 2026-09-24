import { Link } from "@nocoo/basalt";
import { Archive, BookOpen, Box, ExternalLink, Globe } from "lucide-react";
import { useState } from "react";
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
}: {
	project: ProjectIdentity | null;
	github?: string;
}) {
	const destination = project?.github ?? github;
	return (
		<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-medium">
			{destination ? (
				<Link
					href={destination}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1"
				>
					<ExternalLink aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
					GitHub
				</Link>
			) : null}
			{project?.website ? (
				<Link
					href={project.website}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1"
				>
					<Globe aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
					访问站点
				</Link>
			) : null}
			{project ? (
				<Link
					href={project.url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1"
				>
					<BookOpen aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
					项目说明
				</Link>
			) : null}
			{project?.archived ? (
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
}: {
	repo: string;
	description: string | null;
	card?: boolean;
}) {
	const project = useProjectIdentity(repo);
	const summary = project?.description || description;
	return (
		<div className="min-w-0 flex-1" data-project={repo}>
			<Link
				href={`/repos/${repo}`}
				className={`font-semibold text-basalt-foreground hover:text-basalt-primary ${card ? "text-base" : "text-sm"}`}
			>
				<ProjectName repo={repo} project={project} showTitle size={card ? 48 : 32} />
			</Link>
			{summary ? (
				<p
					className={`mt-2 text-basalt-muted-foreground ${card ? "line-clamp-2 min-h-10 text-sm leading-5" : "line-clamp-1 text-xs"}`}
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
}
