import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { CircleHelp } from "lucide-react";
import { type ReactNode, useState } from "react";

export function HelpTooltip({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-6 shrink-0 text-basalt-muted-foreground hover:text-basalt-primary"
					aria-label={label}
					onClick={(event) => {
						// Keep tap-to-open working; Radix otherwise closes tooltips on click.
						event.preventDefault();
						setOpen(true);
					}}
				>
					<CircleHelp className="size-4" strokeWidth={1.5} aria-hidden="true" />
				</Button>
			</TooltipTrigger>
			<TooltipContent className="max-w-80 whitespace-normal text-xs leading-relaxed" sideOffset={6}>
				{children}
			</TooltipContent>
		</Tooltip>
	);
}
