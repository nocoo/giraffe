import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@nocoo/basalt";
import { Info } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Focusable info button beside a key label; the explanation stays out of the header. */
export function HelpTooltip({
	label,
	children,
	className = "",
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<TooltipProvider>
			<Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className={`size-basalt-control-sm shrink-0 align-middle text-basalt-muted-foreground hover:text-basalt-primary ${className}`}
						aria-label={label}
						onFocus={() => setOpen(true)}
						onBlur={() => setOpen(false)}
						onClick={(event) => {
							// Keep tap-to-open working; Radix otherwise closes tooltips on click.
							event.preventDefault();
							setOpen(true);
						}}
					>
						<Info className="size-basalt-icon" strokeWidth={1.5} aria-hidden="true" />
					</Button>
				</TooltipTrigger>
				<TooltipContent
					className="max-w-80 whitespace-normal text-xs leading-relaxed"
					sideOffset={6}
				>
					{children}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
