import { z } from "zod";
import { type AgentResource, createResourceSchema } from "../../lib/agent-resource";
import {
	compareGeneratedAt,
	decodeGithubDailyResource,
	type GithubDailyHistory,
	type GithubDailyResource,
} from "../../lib/github-daily";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

type Row = Omit<AgentResource, "payload"> & { payload: string };
type GeneratedReport = AgentResource & {
	payload: AgentResource["payload"] & { generatedAt: string };
};
const time = z.string().datetime({ offset: true });
function newest(
	left: { id: string; payload: { generatedAt: string } },
	right: { id: string; payload: { generatedAt: string } },
) {
	return (
		compareGeneratedAt(right.payload.generatedAt, left.payload.generatedAt) ||
		(left.id === right.id ? 0 : left.id < right.id ? 1 : -1)
	);
}
async function rows(db: Db, account: string, type: string) {
	return (
		await db
			.prepare(
				"SELECT id,account_id,repository,type,status,source_version,payload,revision,created_at,updated_at FROM agent_resources WHERE account_id=? AND collection='reports' AND type=?",
			)
			.bind(account, type)
			.all<Row>()
	).results;
}
export async function readGithubDailyHistory(db: Db, account: string): Promise<GithubDailyHistory> {
	const items: GithubDailyResource[] = [];
	let invalidCount = 0;
	for (const row of await rows(db, account, "github-daily")) {
		const item = decodeGithubDailyResource(row);
		if (item) items.push(item);
		else invalidCount++;
	}
	return { account_id: account, items: items.sort(newest).slice(0, 7), invalidCount };
}
export async function readLatestReport(db: Db, account: string, query: Record<string, string[]>) {
	const type = query.type;
	if (
		Object.keys(query).length !== 1 ||
		type?.length !== 1 ||
		!createResourceSchema.shape.type.safeParse(type[0]).success
	)
		throw new ApiError(400, "validation_failed", "Exactly one report type is required");
	const selected = type[0] as string;
	if (selected === "github-daily") {
		const history = await readGithubDailyHistory(db, account);
		return {
			account_id: account,
			item: history.items[0] ?? null,
			invalidCount: history.invalidCount,
		};
	}
	let item: GeneratedReport | null = null;
	for (const row of await rows(db, account, selected)) {
		let payload: unknown;
		try {
			payload = JSON.parse(row.payload);
		} catch {
			continue;
		}
		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			!("generatedAt" in payload) ||
			!time.safeParse(payload.generatedAt).success
		)
			continue;
		const candidate = { ...row, payload } as GeneratedReport;
		if (!item || newest(candidate, item) < 0) item = candidate;
	}
	return { account_id: account, item };
}
