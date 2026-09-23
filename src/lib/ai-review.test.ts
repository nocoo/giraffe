import { describe, expect, it } from "vitest";
import { repositoryReportSchema } from "./ai-review";

describe("repository report contract", () => {
	it("validates complete structured reports and rejects missing fields, extras and bad enums", () => {
		const section = { status: "unknown", summary: "Coverage is incomplete.", evidenceIds: [] };
		const report = {
			schemaVersion: 1,
			summary: "No conclusion without complete coverage.",
			overall: "unknown",
			security: section,
			pullRequests: section,
			issues: section,
			delivery: { ...section, trend: "unknown" },
			actions: [],
			limitations: ["Security alerts were unavailable."],
		};
		expect(repositoryReportSchema.parse(report)).toEqual(report);
		expect(repositoryReportSchema.safeParse({ ...report, overall: "good" }).success).toBe(false);
		expect(repositoryReportSchema.safeParse({ ...report, arbitrary: true }).success).toBe(false);
		expect(repositoryReportSchema.safeParse({ ...report, security: undefined }).success).toBe(
			false,
		);
		expect(repositoryReportSchema.safeParse({ ...report, summary: "" }).success).toBe(false);
	});
});
