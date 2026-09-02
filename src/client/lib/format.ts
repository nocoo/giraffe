export function formatDelta(value: number | null, baselineMissing: boolean): string {
	if (baselineMissing || value === null) {
		return "—";
	}
	return String(value);
}
