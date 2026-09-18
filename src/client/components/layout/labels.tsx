export function LanguageLabel({ name }: { name: string | null | undefined }) {
	if (!name) {
		return <span className="text-basalt-muted-foreground">—</span>;
	}
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="size-2 shrink-0 rounded-full bg-basalt-primary" aria-hidden="true" />
			{name}
		</span>
	);
}
