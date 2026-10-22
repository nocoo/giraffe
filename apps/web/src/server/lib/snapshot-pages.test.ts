import { describe, expect, it } from "vitest";
import { assemblePages, latestSnapshotGroups, physicalKinds, splitPages } from "./snapshot-pages";

describe("snapshot-pages", () => {
	it.each([false, true])(
		"P3 includes the final truncated flag in exact UTF-8 page bounds (truncated=%s)",
		(alreadyTruncated) => {
			const limit = 1_500_000;
			const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
			const base = { fetched_at: "t", truncated: alreadyTruncated, repos: [] };
			const budget = limit - bytes({ ...base, truncated: true, repos: [{ blob: "" }] });
			const item = { blob: `${"🦒".repeat(Math.floor(budget / 4))}${"x".repeat(budget % 4)}` };
			expect(bytes({ ...base, truncated: true, repos: [item] })).toBe(limit);
			const result = splitPages("repos", { ...base, repos: [item, item] });
			for (const page of result.pages)
				expect(new TextEncoder().encode(page.payload).length).toBeLessThanOrEqual(limit);
			expect(result.pages.length).toBeLessThanOrEqual(2);
			expect(result.truncated).toBe(true);
			expect((assemblePages("repos", result.pages).repos as unknown[]).length).toBeGreaterThan(0);
		},
	);

	it("P3 preserves complete multibyte items that exactly fit with truncated false", () => {
		const limit = 1_500_000;
		const base = { fetched_at: "t", truncated: false };
		const overhead = new TextEncoder().encode(
			JSON.stringify({ ...base, repos: [{ blob: "" }] }),
		).length;
		const budget = limit - overhead;
		const item = { blob: `${"🦒".repeat(Math.floor(budget / 4))}${"x".repeat(budget % 4)}` };
		const result = splitPages("repos", { ...base, repos: [item, item] });
		expect(result.truncated).toBe(false);
		expect(result.pages).toHaveLength(2);
		for (const page of result.pages)
			expect(new TextEncoder().encode(page.payload).length).toBe(limit);
		expect(assemblePages("repos", result.pages).repos).toEqual([item, item]);
	});

	it("P3 compact fallback also bounds oversized non-list metadata without claiming complete emptiness", () => {
		const result = splitPages("repos", {
			fetched_at: "t",
			truncated: false,
			metadata: "🦒".repeat(400000),
			repos: [{ name: "small" }],
		});
		expect(result.truncated).toBe(true);
		expect(result.pages).toHaveLength(1);
		expect(new TextEncoder().encode(result.pages[0]?.payload).length).toBeLessThanOrEqual(
			1_500_000,
		);
		expect(assemblePages("repos", result.pages)).toMatchObject({
			fetched_at: "t",
			truncated: true,
			repos: [],
		});
	});

	it("P3 rejects metadata that cannot fit even the compact fallback instead of storing an oversized page", () => {
		expect(() =>
			splitPages("languages", { fetched_at: "🦒".repeat(400000), truncated: false, blob: "large" }),
		).toThrow("snapshot metadata exceeds page capacity");
	});

	it("selects whole logical snapshots deterministically across casing and invalid times", () => {
		const page = (kind: string, fetched_at: unknown, number: number) => ({
			kind,
			payload: JSON.stringify({ fetched_at, issues: [{ number }] }),
		});
		const rows = [
			page("repo:owner/app:issues", "2026-10-20T00:00:00Z", 1),
			page("repo:OWNER/APP:issues", "2026-10-20T00:00:00Z", 2),
			page("repo:OWNER/APP:issues#2", "2026-10-20T00:00:00Z", 3),
			page("repo:Owner/App:issues", "invalid", 4),
			page("repo:owner/orphan:issues#2", "2026-10-21T00:00:00Z", 5),
			page("repo:owner/missing:issues", null, 6),
			page("repo:OWNER/MISSING:issues", "invalid", 7),
			page("repo:owner/older:issues", "2026-10-20T00:00:00Z", 8),
			page("repo:OWNER/OLDER:issues", "2026-10-18T00:00:00Z", 9),
		];
		const forward = latestSnapshotGroups(rows);
		const reverse = latestSnapshotGroups([...rows].reverse());
		expect(forward).toEqual(reverse);
		expect(forward.get("repo:owner/app:issues")).toMatchObject({
			resource: "repo:OWNER/APP:issues",
			data: { issues: [{ number: 2 }, { number: 3 }] },
		});
		expect(forward.has("repo:owner/orphan:issues")).toBe(false);
		expect(forward.get("repo:owner/missing:issues")?.resource).toBe("repo:OWNER/MISSING:issues");
		expect(forward.get("repo:owner/older:issues")?.data.issues).toEqual([{ number: 8 }]);
	});

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
		const langs = splitPages("repo:o/n:languages", {
			fetched_at: "t",
			truncated: false,
			languages: { TypeScript: "z".repeat(1_600_000) },
		});
		expect(langs.truncated).toBe(true);
		expect(JSON.parse(langs.pages[0]?.payload ?? "{}")).toMatchObject({ languages: {} });
		const details = splitPages("repo:o/n:details", {
			fetched_at: "t",
			truncated: false,
			blob: "z".repeat(1_600_000),
			default_branch: "main",
		});
		expect(JSON.parse(details.pages[0]?.payload ?? "{}")).toMatchObject({
			truncated: true,
			default_branch: "",
			url: "",
		});
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
