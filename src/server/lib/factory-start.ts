import { z } from "zod";
import { type FactoryRun, makeRun, selectRunRepos } from "../../lib/factory-run";
import type { AccountRow } from "./db/accounts";
import type { Db } from "./db/d1";
import { catalogFactory, getRun, repoStates, startRun } from "./db/factory-runs";
import { ApiError } from "./errors";
import { boundedJson } from "./factory-publish";
import { checkFactoryCapacity, factoryStorage } from "./factory-retention";
import { siteCatalog } from "./factory-site";
import { ACCOUNT_ID_RE } from "./id";
import { repoPolicy, statisticsFactory } from "./repo-statistics";
export const refreshInput = z.object({
	account_id: z.string().regex(ACCOUNT_ID_RE),
	requestKey: z.string().uuid(),
	mode: z.enum(["catalog", "refresh"]),
	depth: z.enum(["quick", "deep"]).default("deep"),
	scope: z.enum(["all", "selected", "filter", "stale", "failed"]).default("selected"),
	repos: z.array(z.string().max(200)).max(500).optional(),
	order: z.array(z.string().max(200)).max(500).optional(),
	repo: z.string().max(200).optional(),
	language: z.string().max(100).optional(),
	topic: z.string().max(100).optional(),
	query: z.string().max(100).optional(),
});

export async function startRefresh(
	db: Db,
	row: Pick<AccountRow, "id" | "login">,
	data: z.infer<typeof refreshInput>,
	now: string,
	trigger: NonNullable<FactoryRun["trigger"]> = "manual",
	schedule?: FactoryRun["schedule"],
): Promise<FactoryRun> {
	const prior = await db
		.prepare("SELECT id,status FROM factory_runs WHERE account_id=? AND request_key=?")
		.bind(row.id, data.requestKey)
		.first<{ id: string; status: string }>();
	if (prior) {
		const existing = await getRun(db, row.id, prior.id);
		if (existing) return existing.run;
	}
	const storage = await factoryStorage(db, row.id);
	if (data.mode === "refresh" && storage.totalBytes >= storage.limitBytes - 2_000_000)
		throw new ApiError(422, "factory_capacity", "factory resource quota reached");
	const rawCatalog = await catalogFactory(db, row.id);
	const policy = await repoPolicy(db, row.id);
	const catalog = rawCatalog ? statisticsFactory(rawCatalog, policy) : null;
	const siteNames = data.mode === "refresh" ? await siteCatalog(db, row.id) : [];
	const selectedNames = data.repos ?? [];
	if (
		data.mode === "refresh" &&
		catalog &&
		data.scope === "selected" &&
		(new Set(selectedNames).size !== selectedNames.length ||
			selectedNames.some(
				(name) => !(siteNames ?? catalog?.repos.map((r) => r.name) ?? []).includes(name),
			))
	)
		throw new ApiError(400, "validation_failed", "invalid repository selection");
	const siteRepos =
		data.scope === "all" ? siteNames : data.scope === "selected" ? selectedNames : [];
	const states = await repoStates(db, row.id);
	if (
		data.mode === "refresh" &&
		(!catalog || siteRepos === null || (data.scope !== "selected" && !catalog.inventory.complete))
	)
		throw new ApiError(409, "catalog_incomplete", "discover complete catalog first");
	let repos: NonNullable<Awaited<ReturnType<typeof catalogFactory>>>["repos"];
	try {
		repos =
			data.mode === "catalog"
				? []
				: selectRunRepos(
						catalog?.repos ?? [],
						states,
						{
							scope: data.scope,
							repos: selectedNames.filter((name) => catalog?.repos.some((r) => r.name === name)),
							language: data.language ?? "",
							topic: data.topic ?? "",
							query: data.query ?? "",
							repo: data.repo ?? "",
						},
						now,
					);
	} catch {
		throw new ApiError(400, "validation_failed", "invalid repository selection");
	}
	if (data.mode === "refresh" && data.scope !== "selected" && data.repos !== undefined)
		throw new ApiError(
			400,
			"validation_failed",
			"repos is membership only; use order for priorities",
		);
	if (
		data.order &&
		(new Set(data.order).size !== data.order.length ||
			data.order.some((name) => !catalog?.repos.some((r) => r.name === name)))
	)
		throw new ApiError(400, "validation_failed", "invalid priority order");
	if (data.order?.length) {
		const order = new Map(data.order.map((name, i) => [name, i]));
		repos.sort((a, b) => (order.get(a.name) ?? 1000) - (order.get(b.name) ?? 1000));
	}
	if (
		data.mode === "refresh" &&
		((data.scope !== "all" && !repos.length && !siteRepos?.length) ||
			repos.length > 500 ||
			(siteRepos?.length ?? 0) > 500)
	)
		throw new ApiError(400, "validation_failed", "select 1 to 500 repositories");
	if (
		data.mode === "refresh" &&
		data.scope !== "all" &&
		repos.length > 0 &&
		repos.every((r) => states.some((s) => s.repo === r.name && s.nextAllowedAt > now))
	)
		throw new ApiError(409, "refresh_cooldown", "all selected repositories are cooling down");
	if (
		trigger !== "manual" &&
		repos.some((repo) =>
			states.some((state) => state.repo === repo.name && state.nextAllowedAt > now),
		)
	)
		throw new ApiError(409, "refresh_cooldown", "scheduled repositories are cooling down");
	const selection = {
		scope: data.scope,
		...(data.repos ? { repos: data.repos } : {}),
		order: repos.map((repo) => repo.name),
		...(data.language ? { language: data.language } : {}),
		...(data.topic ? { topic: data.topic } : {}),
		...(data.query ? { query: data.query } : {}),
		...(data.repo ? { repo: data.repo } : {}),
	};
	const plan = makeRun(
		crypto.randomUUID(),
		row.id,
		row.login,
		data.requestKey,
		data.mode,
		repos,
		now,
		states,
		siteRepos ?? [],
		selection,
		data.depth,
	);
	await checkFactoryCapacity(db, row.id, new TextEncoder().encode(boundedJson(plan)).length);
	plan.trigger = trigger;
	if (schedule) plan.schedule = schedule;
	return startRun(db, plan);
}
