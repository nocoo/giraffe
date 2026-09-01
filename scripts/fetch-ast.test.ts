import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { collectFetchAliases, isFetchCall, walk } from "./fetch-ast";

function hasFetch(code: string): boolean {
	const parsed = parseSync("x.ts", code);
	const aliases = collectFetchAliases(parsed.program);
	let hit = false;
	walk(parsed.program, (node) => {
		if (isFetchCall(node, aliases)) {
			hit = true;
		}
	});
	return hit;
}

describe("collectFetchAliases", () => {
	it("detects assignment aliases", () => {
		expect(hasFetch("let request; request = fetch; request('/x')")).toBe(true);
	});

	it("detects globalThis.fetch aliases", () => {
		expect(hasFetch("const request = globalThis.fetch; request('/x')")).toBe(true);
	});
});
