// Explicit series colors keep Basalt charts on Giraffe's accent in both themes.
// Labels and tooltips distinguish categories without relying on color alone.
const COLORS = [
	"hsl(var(--basalt-primary))",
	"color-mix(in srgb, hsl(var(--basalt-primary)) 60%, hsl(var(--basalt-card)))",
	"color-mix(in srgb, hsl(var(--basalt-primary)) 65%, hsl(var(--basalt-foreground)))",
	"color-mix(in srgb, hsl(var(--basalt-primary)) 30%, hsl(var(--basalt-card)))",
	"color-mix(in srgb, hsl(var(--basalt-primary)) 45%, hsl(var(--basalt-muted-foreground)))",
] as const;

export function chartColor(index: number): string {
	return COLORS[index % COLORS.length] ?? COLORS[0];
}
