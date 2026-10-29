import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";
import { requireCatalogRepo } from "../lib/machine-observations";
import { assertMachineQuery } from "../lib/machine-query";
import { readStarReason, readStars, writeStar } from "../lib/repo-stars";
import { timedJson } from "../lib/timed-json";
import type { MachineVars } from "./machine";

type Ctx = Context<{ Bindings: Env; Variables: MachineVars }>;

export async function getMachineStars(c: Ctx) {
	assertMachineQuery(c.req.query());
	return c.json({ items: await readStars(c.get("db"), c.get("principal").accountId) });
}

export async function getMachineSettings(c: Ctx) {
	const account = c.get("principal").accountId;
	return timedJson(c, {
		account_id: account,
		stars: (await readStars(c.get("db"), account))
			.filter((star) => star.starred)
			.map((star) => star.repo),
		statistics: [],
		statistics_deprecated: true,
		schedules: [{ time: "03:00", timezone: "Asia/Shanghai", cron: "0 19 * * *", scope: "starred" }],
		collectionAvailable: true,
	});
}

export async function machineSetting(c: Ctx) {
	const method = c.req.method;
	if (!["PUT", "DELETE"].includes(method))
		throw new ApiError(405, "method_not_allowed", "method not allowed");
	if (c.req.path.includes("/statistics/"))
		throw new ApiError(410, "deprecated", "statistics settings are replaced by stars");
	const account = c.get("principal").accountId;
	const db = c.get("db");
	const repo = await requireCatalogRepo(
		db,
		account,
		`${c.req.param("owner")}/${c.req.param("name")}`,
	);
	const reason = await readStarReason(c.req.raw);
	const { item, changed } = await writeStar(
		db,
		account,
		repo,
		method === "PUT",
		"agent",
		reason,
		new Date().toISOString(),
	);
	c.set("starUnchanged", !changed);
	return c.json(item);
}
