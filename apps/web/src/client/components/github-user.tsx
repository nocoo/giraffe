import { Avatar, AvatarFallback, AvatarImage } from "@nocoo/basalt";
import { type CSSProperties, useState } from "react";
import {
	githubAvatarColor,
	githubAvatarLetter,
	resolveGithubAvatarUrl,
} from "../lib/github-avatar";

const SIZES = {
	xs: { avatar: "size-5", text: "0.5625rem" },
	sm: { avatar: "size-6", text: "0.625rem" },
	md: { avatar: "size-8", text: "0.75rem" },
	lg: { avatar: "size-10", text: "0.875rem" },
} as const;

export type GithubUserSize = keyof typeof SIZES;

export function GithubAvatar({
	login,
	avatarUrl,
	size = "sm",
	className = "",
}: {
	login: string | null | undefined;
	avatarUrl?: string | null | undefined;
	size?: GithubUserSize;
	className?: string;
}) {
	const trimmed = login?.trim() ?? "";
	const src = resolveGithubAvatarUrl(trimmed, avatarUrl);
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const showImage = Boolean(src && failedSrc !== src);
	const tone = githubAvatarColor(trimmed);
	const { avatar, text } = SIZES[size];
	const fallbackStyle: CSSProperties = {
		backgroundColor: tone,
		color: "#ffffff",
		fontSize: text,
		fontWeight: 600,
	};

	if (trimmed === "") {
		return (
			<Avatar className={`${avatar} ${className}`.trim()} aria-hidden="true">
				<AvatarFallback style={fallbackStyle} data-testid="github-avatar-fallback">
					?
				</AvatarFallback>
			</Avatar>
		);
	}

	return (
		<Avatar className={`${avatar} shrink-0 ${className}`.trim()}>
			{showImage ? (
				<AvatarImage
					src={src ?? undefined}
					alt={trimmed}
					onError={() => {
						if (src) setFailedSrc(src);
					}}
				/>
			) : null}
			<AvatarFallback style={fallbackStyle} data-testid="github-avatar-fallback">
				{githubAvatarLetter(trimmed)}
			</AvatarFallback>
		</Avatar>
	);
}

export function UserChip({
	login,
	avatarUrl,
	size = "sm",
	showLogin = true,
	className = "",
	title,
}: {
	login: string | null | undefined;
	avatarUrl?: string | null | undefined;
	size?: GithubUserSize;
	showLogin?: boolean;
	className?: string;
	title?: string;
}) {
	const trimmed = login?.trim() ?? "";
	if (trimmed === "") {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	return (
		<span
			className={`inline-flex max-w-full min-w-0 items-center gap-2 ${className}`.trim()}
			title={title ?? trimmed}
		>
			<GithubAvatar login={trimmed} avatarUrl={avatarUrl} size={size} />
			{showLogin ? <span className="truncate">{trimmed}</span> : null}
		</span>
	);
}
