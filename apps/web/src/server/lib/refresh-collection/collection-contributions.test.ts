import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { calendarGraphqlFailures } from "../../../../../../tests/fixtures/refresh-upstream";
import { createDb } from "../db/d1";
import { readContributions } from "../machine-contributions";
import {
	readMachineAccountObservation,
	readMachineRepositoryObservation,
} from "../machine-observations";
import { contributionCalendarChunkWindows, contributionWindow } from "../refresh-calendar";
import {
	accountPage,
	connection,
	contributionCalendarPage,
	fixture,
	item,
	now,
	publication,
	repo,
	upstream,
} from "./__tests__/collection-helper";
import { collectAccount, collectRepository } from "./index";
import { collectionDb, publish } from "./store";

afterEach(() => vi.unstubAllGlobals());

describe("unified refresh collection - contributions and publication", () => {
	it.each([
		{},
		{ totalContributions: 0, weeks: [] },
		{
			totalContributions: 0,
			weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: null }] }],
		},
		{ totalContributions: 0, weeks: [{ contributionDays: [{ contributionCount: 0 }] }] },
	])("does not substitute zero for missing contribution data: %j", async (calendar) => {
		const context = await fixture();
		upstream([accountPage(), contributionCalendarPage(calendar)]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect(await publication(context)).toMatchObject({
			contribution: null,
			contributionStatus: "unavailable",
		});
	});
	it.each([
		[
			"a two-day window-only calendar",
			{
				totalContributions: 2,
				weeks: [
					{
						contributionDays: [
							{ date: "2026-10-27", contributionCount: 1 },
							{ date: "2026-10-28", contributionCount: 1 },
						],
					},
				],
			},
		],
		[
			"a calendar with an interior hole",
			{
				totalContributions: 365 * 2 - 2,
				weeks: [
					{
						contributionDays: annualContributionCalendar(
							now,
							2,
						).calendar.weeks[0]?.contributionDays.filter((_, index) => index !== 180),
					},
				],
			},
		],
	])("materializes %s into a saved annual calendar", async (_name, calendar) => {
		const context = await fixture();
		upstream([accountPage(), contributionCalendarPage(calendar)]);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		expect(result.reasons).not.toContain("contributions:empty");
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as {
			contributionStatus: string;
			contribution: { days: { date: string; count: number }[] };
		};
		expect(saved.contributionStatus).toBe("complete");
		expect(saved.contribution.days).toHaveLength(366);
		expect(saved.contribution.days.some((day) => day.count > 0)).toBe(true);
	});
	it("keeps account inventory complete when GraphQL errors only touch contributionsCollection", async () => {
		const context = await fixture();
		upstream([accountPage(), ...calendarGraphqlFailures(now, 40)]);
		await collectAccount(context);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { inventory: { complete: boolean } };
		expect(saved.inventory.complete).toBe(true);
	});
	it("marks contributionStatus partial when chunked calendar refresh fails with retained prior", async () => {
		const context = await fixture();
		upstream([accountPage()]);
		await collectAccount(context);
		await context.env.DB.prepare(
			'UPDATE refresh_accounts SET payload=json_set(payload,\'$.contribution\',json(\'{"days":[{"date":"2026-09-14","count":1}],"total":1,"fetchedAt":"2026-09-15T12:00:00.000Z"}\'),\'$.contributionStatus\',\'complete\') WHERE account_id=\'a\'',
		).run();
		upstream([accountPage(), ...calendarGraphqlFailures(now, 40)]);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as {
			contributionStatus: string;
			contribution: { days: { date: string; count: number }[]; fetchedAt: string };
		};
		expect(saved.contributionStatus).toBe("partial");
		expect(saved.contribution.days).toEqual([{ date: "2026-09-14", count: 1 }]);
		expect(saved.contribution.fetchedAt).toBe("2026-09-15T12:00:00.000Z");
	});
	it("does not mark the account phase partial when a retained contribution calendar exists", async () => {
		const context = await fixture();
		const page = accountPage();
		upstream([page]);
		await collectAccount(context);
		await context.env.DB.prepare(
			'UPDATE refresh_accounts SET payload=json_set(payload,\'$.contribution\',json(\'{"days":[{"date":"2026-09-14","count":1}],"total":1,"fetchedAt":"2026-09-15T12:00:00.000Z"}\'),\'$.contributionStatus\',\'complete\') WHERE account_id=\'a\'',
		).run();
		upstream([page, ...calendarGraphqlFailures(now)]);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		expect(result.reasons).not.toContain("contributions:unavailable");
	});
	it("retains contribution calendar from factory snapshot when refresh_accounts lost it", async () => {
		const context = await fixture();
		const page = accountPage();
		const calendar = {
			days: [
				{
					date: "2026-09-14",
					count: 2,
					fetchedAt: now,
					observedAt: now,
					breakdown: "unavailable" as const,
				},
			],
			total: 2,
			fetchedAt: now,
			observedAt: now,
			timezone: "github",
			typesStatus: "partial" as const,
		};
		await context.env.DB.prepare(
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES('a','factory',?,?)",
		)
			.bind(
				JSON.stringify({
					schema: 1,
					account_id: "a",
					contribution: calendar,
					contributionStatus: "complete",
					contributionObservation: { version: "prior", window: {}, fetchedAt: now },
					repos: [],
				}),
				now,
			)
			.run();
		await context.env.DB.prepare(
			"UPDATE refresh_accounts SET payload=json_remove(payload,'$.contribution') WHERE account_id='a'",
		).run();
		const failures: import("../../../lib/refresh-types").RefreshFailureDetail[] = [];
		context.onFailures = (details) => failures.push(...details);
		upstream([page, ...calendarGraphqlFailures(now)]);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		expect(result.reasons).not.toContain("contributions:unavailable");
		expect(failures.some((entry) => entry.code === "contributions:graphql_error")).toBe(false);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { contribution: { days: { date: string }[] } };
		expect(saved.contribution.days.find((day) => day.date === "2026-09-14")?.date).toBe(
			"2026-09-14",
		);
	});
	it("falls back to the factory snapshot row when paginated factory load fails", async () => {
		const factoryRuns = await import("../db/factory-runs");
		const publishedFactory = vi
			.spyOn(factoryRuns, "publishedFactory")
			.mockRejectedValueOnce(new Error("missing factory pages"));
		const context = await fixture();
		const calendar = {
			days: [
				{
					date: "2026-09-20",
					count: 1,
					fetchedAt: now,
					observedAt: now,
					breakdown: "unavailable" as const,
				},
			],
			total: 1,
			fetchedAt: now,
			observedAt: now,
			timezone: "github",
			typesStatus: "partial" as const,
		};
		await context.env.DB.prepare(
			"INSERT INTO refresh_snapshots(account_id,kind,payload,fetched_at) VALUES('a','factory',?,?)",
		)
			.bind(
				JSON.stringify({
					schema: 1,
					account_id: "a",
					contribution: calendar,
					contributionStatus: "complete",
					repos: [],
				}),
				now,
			)
			.run();
		await context.env.DB.prepare(
			"UPDATE refresh_accounts SET payload=json_remove(payload,'$.contribution') WHERE account_id='a'",
		).run();
		upstream([accountPage(), ...calendarGraphqlFailures(now, 40)]);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { contribution: { days: { date: string }[] } };
		expect(saved.contribution.days.find((day) => day.date === "2026-09-20")?.date).toBe(
			"2026-09-20",
		);
		publishedFactory.mockRestore();
	});
	it("treats contributionCalendar GraphQL errors separately from catalogue inventory", async () => {
		const context = await fixture();
		const page = accountPage();
		upstream([
			page,
			Response.json({
				data: {
					viewer: page.viewer,
					rateLimit: { remaining: 5000, resetAt: "2026-10-29T05:00:00Z" },
				},
				errors: [
					{
						type: "FORBIDDEN",
						path: ["viewer", "contributionsCollection", "contributionCalendar"],
						message: "denied",
					},
				],
			}),
		]);
		await collectAccount(context);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { inventory: { complete: boolean } };
		expect(saved.inventory.complete).toBe(true);
	});
	it("fetches the contribution calendar over a fixed one-year window independent of the refresh window", async () => {
		const context = await fixture();
		const fetch = upstream();
		await collectAccount(context);
		const calendarCall = fetch.mock.calls.find(
			([, init]) =>
				typeof init?.body === "string" && init.body.includes("query RefreshContributionCalendar"),
		);
		const firstChunk = contributionCalendarChunkWindows(
			contributionWindow(now),
			"Asia/Shanghai",
		)[0];
		expect(JSON.parse(String(calendarCall?.[1]?.body)).variables).toMatchObject({
			since: firstChunk?.since,
			until: firstChunk?.until,
		});
		const saved = await publication(context);
		expect(saved.window).toEqual({
			since: "2026-10-27T16:00:00.000Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		});
		expect(saved.contributionObservation.window).toEqual({
			since: "2025-10-29T04:00:00.000Z",
			until: now,
		});
		expect(saved.contribution.days).toHaveLength(366);
		expect(saved.contribution.days[0]).toMatchObject({ date: "2025-10-29", count: 2 });
		expect(saved.contribution.days.at(-1)).toMatchObject({ date: "2026-10-29", count: 2 });
	});
	it("materializes GitHub week order gaps and serves the calendar without activity attribution", async () => {
		const context = await fixture();
		const calendar = annualContributionCalendar(now, 3).calendar;
		const days = calendar.weeks[0]?.contributionDays ?? [];
		const shuffled = [...days.slice(180), ...days.slice(0, 180)];
		upstream([
			accountPage(),
			contributionCalendarPage({
				totalContributions: calendar.totalContributions,
				weeks: [{ contributionDays: shuffled }],
			}),
		]);
		const failures: import("../../../lib/refresh-types").RefreshFailureDetail[] = [];
		context.onFailures = (details) => failures.push(...details);
		const result = await collectAccount(context);
		expect(result.partial).toBe(false);
		expect(result.reasons).not.toContain("contributions:empty");
		expect(failures.some((entry) => entry.code.startsWith("contributions:coverage_"))).toBe(false);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { contribution: { days: { date: string; breakdown: string }[] } };
		expect(saved.contribution.days).toHaveLength(366);
		expect(saved.contribution.days[0]?.breakdown).toBe("unavailable");
		const served = await readContributions(createDb(context.env.DB), "a", {});
		expect(served.data.days).toHaveLength(366);
		expect(served.unavailable).toBe(false);
	});
	it("uses summed contribution totals when GitHub totalContributions disagrees", async () => {
		const context = await fixture();
		const calendar = annualContributionCalendar(now, 4).calendar;
		upstream([accountPage(), contributionCalendarPage({ ...calendar, totalContributions: 0 })]);
		await collectAccount(context);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_accounts WHERE account_id='a'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		) as { contribution: { total: number }; contributionStatus: string };
		expect(saved.contributionStatus).toBe("complete");
		expect(saved.contribution.total).toBe(366 * 4);
	});
	it("derives the one-year contribution window across leap days", () => {
		expect(contributionWindow("2026-10-29T04:00:00.000Z")).toMatchObject({
			since: "2025-10-29T04:00:00.000Z",
			until: "2026-10-29T04:00:00.000Z",
		});
		expect(contributionWindow("2024-02-29T12:00:00.000Z")).toMatchObject({
			since: "2023-03-01T12:00:00.000Z",
			until: "2024-02-29T12:00:00.000Z",
		});
		expect(contributionWindow("2025-03-01T00:00:00.000Z")).toMatchObject({
			since: "2024-03-01T00:00:00.000Z",
			until: "2025-03-01T00:00:00.000Z",
		});
	});
	it("fails closed when account publication prerequisites are absent", async () => {
		const context = await fixture();
		await expect(publish(collectionDb(context), context)).rejects.toMatchObject({
			code: "db_error",
		});
	});
	it("keeps canonical schema and repeatable migration identical", () => {
		const db = new DatabaseSync(":memory:");
		const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
		const migration = readFileSync("migrations/0028_refresh_observations.sql", "utf8");
		db.exec(schema);
		db.exec(migration);
		db.exec(migration);
		expect(schema).toContain(migration.trim());
		db.close();
	});
	it("publishes account inboxes as well as repository sources for browser and machine readers", async () => {
		const context = await fixture();
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					issues: connection([item("I1")]),
					pullRequests: connection([item("P1")]),
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const db = createDb(context.env.DB);
		const issues = await readMachineAccountObservation(db, "a", "issues", "all");
		const prs = await readMachineAccountObservation(db, "a", "prs", "all");
		expect(issues.data.issues).toHaveLength(1);
		expect(prs.data.pull_requests).toHaveLength(1);
		const details = await readMachineRepositoryObservation(db, "a", "owner/project", "details");
		expect(details.data).toMatchObject({ default_branch: "main" });
	});
});
