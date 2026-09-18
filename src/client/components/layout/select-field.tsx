import { Label } from "@nocoo/basalt/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@nocoo/basalt/components/select";
import { useId } from "react";

/** Shared labelled Basalt select; prefix values so an empty filter is a selectable option. */
export function SelectField({
	label,
	value,
	onValueChange,
	options,
	className = "",
}: {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	options: readonly { value: string; label: string; disabled?: boolean }[];
	className?: string;
}) {
	const id = useId();
	return (
		<div className={`giraffe-select-field ${className}`}>
			<Label htmlFor={id}>{label}</Label>
			<Select value={`value:${value}`} onValueChange={(next) => onValueChange(next.slice(6))}>
				<SelectTrigger id={id} aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem
							key={option.value}
							value={`value:${option.value}`}
							disabled={option.disabled ?? false}
						>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
