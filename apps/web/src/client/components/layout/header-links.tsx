"use client";

import { LinkButton } from "@nocoo/basalt/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt/components/tooltip";
import type { ReactElement } from "react";
import { GithubIcon } from "./github-icon";

export function HeaderTooltip({ label, children }: { label: string; children: ReactElement }) {
	return (
		<Tooltip delayDuration={0}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="bottom" sideOffset={6}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}

export function HexlyLink() {
	return (
		<HeaderTooltip label="Giraffe on hexly.ai">
			<LinkButton
				variant="ghost"
				size="icon"
				href="https://hexly.ai/projects/giraffe"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="Giraffe on hexly.ai (opens in a new tab)"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.5}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="m12 2 8.66 5v10L12 22l-8.66-5V7Z" />
					<path d="M12 2v20M3.34 7l17.32 10m0-10L3.34 17" />
				</svg>
				<span className="sr-only">Giraffe on hexly.ai (opens in a new tab)</span>
			</LinkButton>
		</HeaderTooltip>
	);
}

export function GithubRepoLink() {
	return (
		<HeaderTooltip label="GitHub repository">
			<LinkButton
				variant="ghost"
				size="icon"
				href="https://github.com/nocoo/giraffe"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="GitHub"
			>
				<GithubIcon aria-hidden="true" strokeWidth={1.5} />
			</LinkButton>
		</HeaderTooltip>
	);
}
