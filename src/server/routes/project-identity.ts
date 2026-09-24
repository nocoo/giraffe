import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { ApiError, jsonOk, toErrorResponse } from "../lib/errors";
import { fetchProjectIdentity, projectApiBase } from "../lib/project-identity";

export async function getProjectIdentity(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	let response: Response;
	try {
		if (new URL(c.req.url).search)
			throw new ApiError(400, "validation_failed", "query parameters are not supported");
		const project = await fetchProjectIdentity(
			`${c.req.param("owner")}/${c.req.param("repo")}`,
			projectApiBase(c.env),
		);
		response = jsonOk(project);
	} catch (error) {
		response = toErrorResponse(error);
	}
	response.headers.set("Cache-Control", "no-store");
	return response;
}
