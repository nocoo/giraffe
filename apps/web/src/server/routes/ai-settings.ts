import type { Context } from "hono";
import type { AiKind } from "../../lib/ai-settings";
import type { AppVars, Env } from "../env";
import { testAiConnection } from "../lib/ai-models";
import { getPublicAiSettings, resolveAiDraft, saveAiSettings } from "../lib/ai-settings";
import { ApiError, jsonOk } from "../lib/errors";
import { readJson } from "../lib/read-body";

type AiContext = Context<{ Bindings: Env; Variables: AppVars }>;

function settingsKind(c: AiContext): AiKind {
	const kind = c.req.param("kind");
	if (kind !== "summary" && kind !== "judgment")
		throw new ApiError(404, "not_found", "AI settings not found");
	return kind;
}

export async function getAiSettings(c: AiContext): Promise<Response> {
	return jsonOk({ settings: await getPublicAiSettings(c.get("db")) }, 200, {
		"cache-control": "no-store",
	});
}

export async function postAiSettings(c: AiContext): Promise<Response> {
	const kind = settingsKind(c);
	const config = await resolveAiDraft(c.env, c.get("db"), kind, await readJson(c.req.raw, 8192));
	return jsonOk(await saveAiSettings(c.env, c.get("db"), config), 200, {
		"cache-control": "no-store",
	});
}

export async function testAiSettings(c: AiContext): Promise<Response> {
	const kind = settingsKind(c);
	const config = await resolveAiDraft(c.env, c.get("db"), kind, await readJson(c.req.raw, 8192));
	try {
		await testAiConnection(config);
	} catch {
		throw new ApiError(
			502,
			"ai_connection_failed",
			"AI connection test failed; check the endpoint, model and API key",
		);
	}
	return jsonOk({ ok: true }, 200, { "cache-control": "no-store" });
}

export async function deleteAiSettings(c: AiContext): Promise<Response> {
	await c.get("db").prepare("DELETE FROM ai_settings WHERE kind = ?").bind(settingsKind(c)).run();
	return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
