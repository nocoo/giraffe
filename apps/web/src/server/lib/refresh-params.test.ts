import { describe, expect, it } from "vitest";
import { parseRefreshParams, refreshDays } from "./refresh-params";

const now = new Date("2026-10-28T19:00:00.000Z");
describe("unified refresh calendar parameters", () => {
	it("defaults to the previous Shanghai calendar day and every supported dimension", () => {
		const params = parseRefreshParams({}, now);
		expect(params).toEqual({
			since: "2026-10-28",
			until: "2026-10-28",
			timezone: "Asia/Shanghai",
			dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
			force: false,
		});
		expect(refreshDays(params)).toEqual([
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
		]);
	});
	it("uses real DST boundaries instead of adding 24 hours", () => {
		const params = parseRefreshParams(
			{
				since: "2026-03-08",
				until: "2026-03-09",
				timezone: "America/New_York",
				dimensions: ["commits"],
				force: true,
				repo: "octo/Hello",
			},
			now,
		);
		expect(refreshDays(params)).toEqual([
			{ date: "2026-03-08", since: "2026-03-08T05:00:00.000Z", until: "2026-03-09T04:00:00.000Z" },
			{ date: "2026-03-09", since: "2026-03-09T04:00:00.000Z", until: "2026-03-10T04:00:00.000Z" },
		]);
		expect(params.repo).toBe("octo/Hello");
	});
	it.each([
		null,
		[],
		{ mode: "deep" },
		{ requestKey: "client-retry" },
		{ force: "yes" },
		{ repo: "bad" },
		{ repo: "../repo" },
		{ timezone: "bad/zone" },
		{ dimensions: [] },
		{ dimensions: ["dependencies"] },
		{ dimensions: ["prs", "prs"] },
		{ since: "2026-02-30" },
		{ since: "2026-10-28", until: "2026-10-27" },
		{ until: "2026-10-29" },
		{ since: "2026-01-01", until: "2026-02-01" },
	])("rejects unsupported or unsafe parameters %j", (value) => {
		expect(() => parseRefreshParams(value, now)).toThrow();
	});
	it("accepts a 31-day closed window and UTC", () => {
		const params = parseRefreshParams(
			{ since: "2026-08-01", until: "2026-08-31", timezone: "UTC" },
			now,
		);
		expect(refreshDays(params)).toHaveLength(31);
		expect(refreshDays(params)[0]?.since).toBe("2026-08-01T00:00:00.000Z");
	});
});
