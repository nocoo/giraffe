import { expect, it } from "vitest";
import { repoMetaWriteSchema } from "./repo-meta";

it("R6 accepts strict nonempty metadata patches and ISO timestamps with offsets", () => {
	for (const category of ["app", "docs-vault", "profile", "repro", "derivative"])
		expect(repoMetaWriteSchema.parse({ category })).toEqual({ category });
	const patch = {
		created_at: "2020-02-29T08:30:00+08:00",
		archived_at: "2026-10-22T00:00:00.000Z",
		exclusion_reason: "x".repeat(200),
	};
	expect(repoMetaWriteSchema.parse(patch)).toEqual(patch);
	expect(repoMetaWriteSchema.parse({ exclusion_reason: "" })).toEqual({ exclusion_reason: "" });
});

it.each([
	null,
	[],
	{},
	{ category: "other" },
	{ category: null },
	{ created_at: null },
	{ archived_at: null },
	{ exclusion_reason: null },
	{ exclusion_reason: "x".repeat(201) },
	{ created_at: "2026-10-22" },
	{ created_at: "2026-10-22T00:00:00" },
	{ archived_at: "2026-02-30T00:00:00Z" },
	{ created_at: 123 },
	{ first_seen_at: "2026-10-22T00:00:00Z" },
	{ deleted_at: "2026-10-22T00:00:00Z" },
	{ field_sources: { category: "agent" }, category: "app" },
	{ category: "app", unknown: true },
	JSON.parse('{"category":"app","__proto__":{"ignored":true}}'),
])("R6 rejects invalid or server-owned metadata patches %j", (input) => {
	expect(repoMetaWriteSchema.safeParse(input).success).toBe(false);
});
