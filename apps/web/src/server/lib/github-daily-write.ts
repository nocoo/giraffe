import { z } from "zod";
import {
	type AgentResource,
	createResourceSchema,
	updateResourceSchema,
} from "../../lib/agent-resource";
import {
	decodeGithubDaily,
	decodeGithubDailyResource,
	type GithubDaily,
} from "../../lib/github-daily";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

type Row = Omit<AgentResource, "payload"> & { payload: string };
const invalid = () =>
	new ApiError(
		400,
		"validation_failed",
		"Invalid daily report; use canonical POST after deleting an invalid legacy report",
	);
const payloadSchema = z.custom<GithubDaily>((value) => decodeGithubDaily(value) !== null);
const createSchema = createResourceSchema.extend({
	type: z.literal("github-daily"),
	repository: z.null().default(null),
	status: z.literal("completed"),
	payload: payloadSchema,
});
export const reportPatchEnvelopeSchema = updateResourceSchema
	.omit({ payload: true })
	.extend({ payload: z.unknown().optional() });
const patchSchema = updateResourceSchema
	.extend({
		type: z.literal("github-daily").optional(),
		repository: z.null().optional(),
		status: z.literal("completed").optional(),
		payload: payloadSchema.optional(),
		revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.refine((value) => Object.values(value).every((field) => field !== undefined));
const COLUMNS =
	"id,account_id,repository,type,status,source_version,payload,revision,created_at,updated_at";
const DATE = "json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.date')";

export async function createDailyReport(
	db: Db,
	account: string,
	input: unknown,
): Promise<AgentResource> {
	const parsed = createSchema.safeParse(input);
	if (!parsed.success) throw invalid();
	const value = parsed.data;
	const id = `github-daily-${value.payload.date}`;
	if (value.id !== undefined && value.id !== id) throw invalid();
	const now = new Date().toISOString();
	const row = await db
		.prepare(
			`INSERT INTO agent_resources(account_id,collection,id,repository,type,status,source_version,payload,created_at,updated_at) VALUES(?,'reports',?,NULL,'github-daily','completed',?,?,?,?) ON CONFLICT(account_id,collection,id) DO UPDATE SET status=excluded.status,source_version=excluded.source_version,payload=excluded.payload,revision=agent_resources.revision+1,updated_at=excluded.updated_at WHERE agent_resources.type='github-daily' AND agent_resources.repository IS NULL AND ${DATE}=json_extract(excluded.payload,'$.date') AND typeof(agent_resources.revision)='integer' AND agent_resources.revision>=1 AND agent_resources.revision<9007199254740991 RETURNING ${COLUMNS}`,
		)
		.bind(account, id, value.source_version, JSON.stringify(value.payload), now, now)
		.first<Row>();
	if (!row)
		throw new ApiError(409, "resource_exists", "Daily report ID collides with another resource");
	return { ...row, payload: JSON.parse(row.payload) as AgentResource["payload"] };
}

export async function updateDailyReport(
	db: Db,
	account: string,
	previous: Row,
	input: unknown,
): Promise<AgentResource> {
	const parsed = patchSchema.safeParse(input);
	const current = decodeGithubDailyResource(previous);
	if (
		!parsed.success ||
		!current ||
		(parsed.data.payload && parsed.data.payload.date !== current.payload.date)
	)
		throw invalid();
	const item = { ...current, ...parsed.data, updated_at: new Date().toISOString() };
	const row = await db
		.prepare(
			`UPDATE agent_resources SET status=?,source_version=?,payload=?,revision=revision+1,updated_at=? WHERE account_id=? AND collection='reports' AND id=? AND revision=? AND revision<9007199254740991 AND type='github-daily' AND repository IS NULL AND ${DATE}=? RETURNING ${COLUMNS}`,
		)
		.bind(
			item.status,
			item.source_version,
			JSON.stringify(item.payload),
			item.updated_at,
			account,
			current.id,
			parsed.data.revision,
			current.payload.date,
		)
		.first<Row>();
	if (!row) throw new ApiError(409, "revision_conflict", "Daily report changed");
	return { ...row, payload: JSON.parse(row.payload) as AgentResource["payload"] };
}
