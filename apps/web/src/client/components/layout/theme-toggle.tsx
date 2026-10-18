"use client";

import { ThemeToggle as BasaltThemeToggle } from "@nocoo/basalt/components/theme-toggle";
import { useTheme } from "@nocoo/basalt/providers/theme";
import { HeaderTooltip } from "./header-links";

export type ThemeToggleProps = { "aria-label"?: string };

export function ThemeToggle({ "aria-label": ariaLabel = "切换主题" }: ThemeToggleProps = {}) {
	const { theme } = useTheme();
	const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
	return (
		<HeaderTooltip
			label={
				nextTheme === "system"
					? "跟随系统主题"
					: nextTheme === "dark"
						? "切换为深色主题"
						: "切换为浅色主题"
			}
		>
			<span className="inline-flex">
				<BasaltThemeToggle aria-label={ariaLabel} />
			</span>
		</HeaderTooltip>
	);
}
