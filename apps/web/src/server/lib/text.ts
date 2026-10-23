export function clipText(value: string, length: number): string {
	return Array.from(value).slice(0, length).join("");
}
