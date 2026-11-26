import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCalendarGraphqlRequests as calcAccountCalendarRequests } from "../../../../../../tests/fixtures/refresh-upstream";
import { MAX_FETCHES } from "../github-client";
import { contributionCalendarChunkWindows, contributionWindow } from "../refresh-calendar";
import {
	accountPage,
	fixture,
	now,
	publication,
	repo,
	sourceSnapshot,
	upstream,
} from "./__tests__/collection-helper";
import { collectAccount, collectRepository } from "./index";

const accountCalendarGraphqlRequests = (at = now, catalogPages = 1) =>
	calcAccountCalendarRequests(at, catalogPages);

afterEach(() => vi.unstubAllGlobals());

describe("unified refresh collection - catalog and selection", () => {
	it("does not advance factory publication when publishFactorySnapshot is false", async () => {
		const context = await fixture();
		upstream([accountPage()]);
		await collectAccount(context);
		const before = await publication(context);
		context.publishFactorySnapshot = false;
		upstream([accountPage()]);
		await collectAccount(context);
		expect(await publication(context)).toEqual(before);
	});
	it("discovers once, never auto-stars, and skips unstarred repositories the next day", async () => {
		const context = await fixture();
		upstream([
			accountPage(),
			accountPage(),
			accountPage([repo()], false, null, "2026-10-30T04:00:00.000Z"),
		]);
		expect(await collectAccount(context)).toMatchObject({
			requests: accountCalendarGraphqlRequests(),
			requestBreakdown: { graphql: accountCalendarGraphqlRequests(), rest: 0 },
			partial: false,
			reasons: [],
			repos: ["owner/project"],
		});
		expect(await collectAccount(context)).toMatchObject({
			requests: accountCalendarGraphqlRequests(),
			requestBreakdown: { graphql: accountCalendarGraphqlRequests(), rest: 0 },
			partial: false,
			reasons: [],
			repos: ["owner/project"],
		});
		const next = { ...context, now: "2026-10-30T04:00:00.000Z" };
		expect((await collectAccount(next)).repos).toEqual([]);
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	}, 15_000);
	it("paginates the full catalogue and selects starred identities", async () => {
		const context = await fixture();
		await context.env.DB.prepare(
			"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/second',1,'owner',?)",
		)
			.bind(now)
			.run();
		upstream([accountPage([repo()], true, "cursor"), accountPage([repo("R_2", "owner/second")])]);
		expect((await collectAccount(context)).repos).toEqual(["owner/project", "owner/second"]);
		expect(
			(await context.env.DB.prepare("SELECT * FROM refresh_catalog").all()).results,
		).toHaveLength(2);
	});
	it("validates adhoc repositories against the complete catalogue", async () => {
		const context = await fixture();
		context.run.params.repo = "owner/missing";
		upstream([accountPage()]);
		await expect(collectAccount(context)).rejects.toMatchObject({ code: "not_found" });
	});
	it("does not materialize unknown or renamed identities using cached old names", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repo("R_other") }]);
		await collectAccount(context);
		await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
			code: "github_error",
		});
	});
	it("isolates immutable identities even when a repository name is reused", async () => {
		const context = await fixture();
		const fetch = upstream([
			accountPage(),
			{ node: repo() },
			accountPage([repo("R_new")]),
			{ node: repo("R_new") },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).requests).toBe(4);
		expect((await publication(context)).repos.map((repo: { id: string }) => repo.id)).toEqual([
			"R_new",
		]);
		expect(fetch).toHaveBeenCalledTimes(38);
	});
	it("releases only a confirmed reused name when the current catalogue is partial", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["commits"];
		upstream([
			accountPage([repo(), repo("R_other", "owner/unobserved")]),
			{ node: repo() },
			accountPage([repo("R_new")], true, "failed-page"),
			new Error("transient"),
			new Error("transient"),
			{ node: repo("R_new") },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await collectAccount(context)).partial).toBe(true);
		const active = await context.env.DB.prepare(
			"SELECT repo_id,repo FROM refresh_catalog WHERE active=1 ORDER BY repo",
		).all<{ repo_id: string; repo: string }>();
		expect(active.results).toEqual([
			{ repo_id: "R_new", repo: "owner/project" },
			{ repo_id: "R_other", repo: "owner/unobserved" },
		]);
		expect((await publication(context)).repos).toEqual([]);
		expect(await sourceSnapshot(context, "repo:owner/project:details")).toMatchObject({});
		expect((await collectRepository(context, "owner/project")).requests).toBe(1);
		expect((await publication(context)).repos.map((value: { id: string }) => value.id)).toEqual([
			"R_new",
		]);
	});
	it("allows explicitly validated adhoc requests without starring", async () => {
		const context = await fixture();
		context.run.params.repo = "OWNER/PROJECT";
		upstream();
		expect((await collectAccount(context)).repos).toEqual(["owner/project"]);
		await expect(collectRepository(context, "owner/unknown")).rejects.toMatchObject({
			code: "not_found",
		});
	});
	it("does not accept an unrelated token account", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.login = "other";
		upstream([page]);
		await expect(collectAccount(context)).rejects.toMatchObject({ code: "github_unauthorized" });
	});
	it.each([
		null,
		[{ id: "", nameWithOwner: "owner/project" }],
		[{ id: "id", nameWithOwner: "invalid" }],
	])("publishes partial rather than false empty catalogue success: %j", async (values) => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.nodes = values as never;
		upstream([page]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect((await publication(context)).inventory.complete).toBe(false);
	});
	it("preserves a partial catalogue when a later page fails", async () => {
		const context = await fixture();
		upstream([accountPage([repo()], true, "next"), new Error("network"), new Error("network")]);
		expect(await collectAccount(context)).toMatchObject({
			requests: 3 + accountCalendarGraphqlRequests() - 1,
			requestBreakdown: { graphql: 3 + accountCalendarGraphqlRequests() - 1, rest: 0 },
			partial: true,
			reasons: ["catalog:incomplete"],
			repos: ["owner/project"],
		});
	});
	it.each([null, "repeat"])("stops missing or repeated catalogue cursors: %s", async (cursor) => {
		const context = await fixture();
		upstream([accountPage([repo()], true, cursor), accountPage([repo()], true, cursor)]);
		expect((await collectAccount(context)).partial).toBe(true);
	});
	it("caps pathological catalogue pagination below the GitHub request budget", async () => {
		const context = await fixture();
		const chunks = contributionCalendarChunkWindows(
			contributionWindow(now),
			"Asia/Shanghai",
		).length;
		const fetch = upstream(
			Array.from({ length: 35 }, (_, index) =>
				accountPage([repo(`R_${index}`, `owner/repo${index}`)], true, String(index)),
			),
		);
		await collectAccount(context);
		expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/graphql"))).toHaveLength(
			Math.min(35, MAX_FETCHES - chunks - 1) + chunks,
		);
		const calendarBodies = fetch.mock.calls
			.slice(-chunks)
			.map(([, init]) => String(init?.body ?? ""));
		expect(calendarBodies.every((body) => body.includes("RefreshContributionCalendar"))).toBe(true);
	});
	it("does not leak saved sources across repository identity replacement", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repo() }, accountPage([repo("R_new")])]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await collectAccount(context);
		expect(
			(
				await context.env.DB.prepare(
					"SELECT kind FROM refresh_snapshots WHERE kind LIKE 'repo:%'",
				).all()
			).results,
		).toEqual([]);
		expect(await publication(context)).toMatchObject({ repos: [] });
	});
	it("marks restricted and truncated account catalogues incomplete without clearing known rows", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.totalCount = 2;
		delete (page.viewer as { avatarUrl?: string }).avatarUrl;
		upstream([page]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect(
			(
				await context.env.DB.prepare("SELECT avatar_url FROM accounts").first<{
					avatar_url: string;
				}>()
			)?.avatar_url,
		).toBe("");
	});
	it("preserves known catalogue data when retries exhaust the transport budget", async () => {
		const context = await fixture();
		upstream(
			Array.from({ length: 25 }, (_, index) => [
				new Error("network"),
				accountPage([repo(`R_${index}`, `owner/repo${index}`)], true, String(index)),
			]).flat(),
		);
		const result = await collectAccount(context);
		expect(result.requests).toBe(40);
		expect(result.partial).toBe(true);
	});
	it.each([
		{
			label: "another owner",
			node: { ...repo("R_other", "someone/project"), owner: { login: "someone" } },
		},
		{ label: "a fork", node: { ...repo(), isFork: true } },
		{ label: "a historical repository", node: { ...repo(), createdAt: "2026-10-01T00:00:00Z" } },
		{ label: "a repository without createdAt", node: { ...repo(), createdAt: undefined } },
		{ label: "a repository without an owner", node: { ...repo(), owner: undefined } },
		{
			label: "a repository created after this Shanghai day",
			node: { ...repo(), createdAt: "2026-10-30T00:00:00Z" },
		},
	])("never promotes $label into the automatic scope of an empty database", async ({ node }) => {
		const context = await fixture();
		upstream([accountPage([node as never])]);
		expect(await collectAccount(context)).toMatchObject({
			requests: accountCalendarGraphqlRequests(),
			requestBreakdown: { graphql: accountCalendarGraphqlRequests(), rest: 0 },
			partial: false,
			reasons: [],
			repos: [],
		});
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	});
	it("never promotes an unreadable catalogue payload", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.totalCount = 2;
		await context.env.DB.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a','R_broken','owner/broken','2026-10-29','Asia/Shanghai','{not json',?,1)",
		)
			.bind(now)
			.run();
		upstream([page]);
		expect(await collectAccount(context)).toMatchObject({
			partial: true,
			reasons: ["catalog:incomplete"],
			repos: ["owner/project"],
		});
	});
	it("selects owner-created repositories owned by the account owner case-insensitively", async () => {
		const context = await fixture();
		upstream([accountPage([{ ...repo(), owner: { login: "OWNER" } } as never])]);
		expect((await collectAccount(context)).repos).toEqual(["owner/project"]);
	});
	it("includes starred repositories of any owner and excludes unstarred foreign ones", async () => {
		const context = await fixture();
		await context.env.DB.batch([
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','other/lib',1,'owner',?)",
			).bind(now),
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/chosen',1,'owner',?)",
			).bind(now),
		]);
		upstream([
			accountPage([
				{
					...repo("R_star", "other/lib"),
					owner: { login: "other" },
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
				{
					...repo("R_plain", "other/plain"),
					owner: { login: "other" },
					createdAt: "2026-10-29T02:00:00Z",
				} as never,
				{
					...repo("R_chosen", "owner/chosen"),
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
			]),
		]);
		expect((await collectAccount(context)).repos).toEqual(["other/lib", "owner/chosen"]);
	});
	it("restricts a lookback backfill to locally starred repositories without a new-repo exception", async () => {
		const context = await fixture();
		await context.env.DB.batch([
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','other/lib',1,'owner',?)",
			).bind(now),
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/chosen',1,'owner',?)",
			).bind(now),
		]);
		context.run.params.lookbackDays = 90;
		upstream([
			accountPage([
				{
					...repo("R_star", "other/lib"),
					owner: { login: "other" },
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
				{
					...repo("R_plain", "other/plain"),
					owner: { login: "other" },
					createdAt: "2026-10-29T02:00:00Z",
				} as never,
				{
					...repo("R_fresh", "owner/fresh"),
					createdAt: "2026-10-29T02:00:00Z",
				} as never,
				{
					...repo("R_chosen", "owner/chosen"),
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
				{
					...repo("R_legacy", "owner/legacy"),
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
			]),
		]);
		expect(await collectAccount(context)).toMatchObject({
			requests: accountCalendarGraphqlRequests(),
			requestBreakdown: { graphql: accountCalendarGraphqlRequests(), rest: 0 },
			partial: false,
			reasons: [],
			repos: ["other/lib", "owner/chosen"],
		});
	});
	it("selects every automatically eligible repository without a lookback", async () => {
		const context = await fixture();
		await context.env.DB.prepare(
			"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','other/lib',1,'owner',?)",
		)
			.bind(now)
			.run();
		upstream([
			accountPage([
				{
					...repo("R_star", "other/lib"),
					owner: { login: "other" },
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
				{
					...repo("R_fresh", "owner/fresh"),
					createdAt: "2026-10-29T02:00:00Z",
				} as never,
			]),
		]);
		expect((await collectAccount(context)).repos).toEqual(["other/lib", "owner/fresh"]);
	});
	it("keeps an explicit repository request independent of automatic selection", async () => {
		const context = await fixture();
		context.run.params.repo = "OTHER/legacy";
		upstream([
			accountPage([
				{ ...repo("R_legacy", "other/legacy"), createdAt: "2020-01-01T00:00:00Z" } as never,
			]),
		]);
		expect(await collectAccount(context)).toMatchObject({
			partial: false,
			repos: ["other/legacy"],
		});
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	});
});
