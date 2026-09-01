import { describe, expect, it } from "vitest";
import { assemblePages, physicalKinds, splitPages } from "./snapshot-pages";

describe("snapshot-pages", () => {
	it("keeps a small payload on one page", () => {
		const payload = { fetched_at: "t", truncated: false, repos: [{ n: 1 }] };
		const { pages, truncated } = splitPages("repos", payload);
		expect(truncated).toBe(false);
		expect(pages).toHaveLength(1);
		expect(pages[0]?.kind).toBe("repos");
		expect(assemblePages("repos", pages)).toMatchObject({ repos: [{ n: 1 }] });
		expect(physicalKinds("repos")).toEqual(["repos", "repos#2"]);
	});

	it("splits arrays across two pages and flags overflow", () => {
		const item = { blob: "x".repeat(800_000) };
		const payload = { fetched_at: "t", truncated: false, repos: [item, item, item, item] };
		const { pages, truncated } = splitPages("repos", payload);
		expect(truncated).toBe(true);
		expect(pages.length).toBeGreaterThanOrEqual(1);
		expect(pages.length).toBeLessThanOrEqual(2);
		const assembled = assemblePages("repos", pages);
		expect(Array.isArray(assembled.repos)).toBe(true);
	});

	it("moves leftover items onto the second page", () => {
		const item = { blob: "x".repeat(900_000) };
		const { pages, truncated } = splitPages("repos", {
			fetched_at: "t",
			truncated: false,
			repos: [item, item, item],
		});
		expect(pages.length).toBe(2);
		expect(truncated).toBe(true);
	});

	it("drops a single oversized element", () => {
		const huge = { blob: "y".repeat(1_600_000) };
		const { truncated, pages } = splitPages("repos", {
			fetched_at: "t",
			truncated: false,
			repos: [huge, { n: 1 }],
		});
		expect(truncated).toBe(true);
		expect(JSON.stringify(pages)).not.toContain("yyyy");
	});

	it("truncates non-array oversized payloads and empty assemblies", () => {
		const { truncated } = splitPages("languages", {
			fetched_at: "t",
			truncated: false,
			blob: "z".repeat(1_600_000),
		});
		expect(truncated).toBe(true);
		const empty = splitPages("repos", {
			fetched_at: "t",
			truncated: false,
			repos: [{ blob: "y".repeat(1_600_000) }],
		});
		expect(empty.truncated).toBe(true);
		expect(assemblePages("repos", [])).toEqual({ fetched_at: "", truncated: false });
		expect(
			assemblePages("repos", [
				{ kind: "repos", payload: JSON.stringify({ repos: [1] }) },
				{ kind: "repos#2", payload: JSON.stringify({ repos: "nope" }) },
			]),
		).toEqual({ repos: [1] });
	});
});
