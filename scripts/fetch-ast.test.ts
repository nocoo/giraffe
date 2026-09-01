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

	it("detects computed fetch", () => {
		expect(hasFetch('const request = globalThis["fetch"]; request("/x")')).toBe(true);
	});

	it("detects fetch.bind", () => {
		expect(hasFetch("const request = fetch.bind(globalThis); request('/x')")).toBe(true);
	});

	it("detects fetch.call and fetch.apply", () => {
		expect(hasFetch('fetch.call(globalThis, "/x")')).toBe(true);
		expect(hasFetch('fetch.apply(globalThis, ["/x"])')).toBe(true);
	});

	it("does not flag unrelated calls", () => {
		expect(hasFetch("const request = other; request('/x')")).toBe(false);
	});
});
