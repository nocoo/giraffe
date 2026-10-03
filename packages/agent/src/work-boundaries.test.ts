import { expect, it } from "vitest";
import { configSchema } from "./config.ts";
import { safeDiagnostics } from "./diagnostics.ts";
import { githubRead } from "./github.ts";
import { boundedProgress, cronStatusSchema, workRunSchema } from "./work-contracts.ts";

it("keeps diagnostic credentials out of bounded persisted progress", () => {
	const output = safeDiagnostics(
		`-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nAuthorization: Bearer private\nCookie: private\napi_key="private"\nhttps://user:pass@example.com\nghp_abcdefghijklmnopqrstuvw\neyJab.cd.ef\n\u0000${"z".repeat(5000)}\n${"汉".repeat(1000)}`,
	);
	expect(output).not.toContain("secret");
	expect(output).not.toContain("private");
	expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2048);
	expect(safeDiagnostics("ok\tgood")).toBe("ok\tgood");
	expect(safeDiagnostics("-----BEGIN PRIVATE KEY-----\nsecret")).toBe("[redacted]");
	expect(
		safeDiagnostics("password='private'\nsecret=private\nProxy-Authorization: private"),
	).not.toContain("private");
});

it("rejects unsafe live read paths and old schedules", async () => {
	await expect(githubRead("../user")).rejects.toThrow("Invalid GitHub read path");
	expect(configSchema.safeParse({ watch: {}, repairs: {} }).success).toBe(false);
	expect(
		workRunSchema.safeParse({ occurrence: "one", events: [], updatedAt: "2026-10-03T00:00:00Z" })
			.success,
	).toBe(true);
	expect(cronStatusSchema.safeParse({}).success).toBe(false);
});

it("bounds multibyte events and typed per-repository progress below the generic API budget", () => {
	const repositories = Object.fromEntries(
		Array.from({ length: 30 }, (_, index) => [
			`owner/repo-${index}`,
			{
				tasks: ["dependency:1", "pr:2"],
				worker: 1,
				reviewer: 2,
				round: 20,
				findings: Array(8).fill("汉".repeat(500)),
				head: "abc",
				status: "exhausted",
			},
		]),
	);
	const bounded = boundedProgress({
		occurrence: "run",
		events: Array(80).fill("汉".repeat(2000)),
		updatedAt: "2026-10-03T00:00:00Z",
		repositories,
	});
	expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(60000);
	expect(workRunSchema.parse(bounded).repositories["owner/repo-0"]?.round).toBe(20);
	expect(Object.keys(bounded.repositories)).toHaveLength(25);
	expect(boundedProgress({ ...bounded, repositories: {}, events: [] }).events).toEqual([]);
});

it("preserves every task ID and outcome when multibyte disposition reasons exceed the payload budget", () => {
	const tasks = Array.from({ length: 100 }, (_, index) => `dependency:${9007199254740000 + index}`);
	const repositories = Object.fromEntries(
		Array.from({ length: 25 }, (_, index) => [
			`owner/repo-${index}`,
			{
				tasks,
				worker: 1,
				reviewer: 2,
				round: 20,
				findings: [],
				head: "abc",
				status: "deferred",
				dispositions: tasks.map((task) => ({
					task,
					outcome: "deferred" as const,
					reason: "汉".repeat(500),
				})),
			},
		]),
	);
	const progress = boundedProgress({
		occurrence: "run",
		events: [],
		updatedAt: "2026-10-03T00:00:00Z",
		repositories,
	});
	expect(Buffer.byteLength(JSON.stringify(progress))).toBeLessThanOrEqual(60000);
	for (const summary of Object.values(workRunSchema.parse(progress).repositories)) {
		expect(summary.tasks).toEqual(tasks);
		expect(summary.dispositionOutcomes ?? summary.dispositions?.map(() => "D").join("")).toBe(
			"D".repeat(100),
		);
	}
	expect(Object.values(progress.repositories).some((summary) => summary.detailsOmitted)).toBe(true);
});
