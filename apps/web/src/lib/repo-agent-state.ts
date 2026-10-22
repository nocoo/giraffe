import { z } from "zod";

export const REPO_AGENT_STATE_MAX_BYTES = 16_384;
export const REPO_AGENT_STATE_MAX_DEPTH = 64;
export type AgentStateStatus = "ok" | "attention" | "blocked";
export type RepoAgentState = {
	account_id: string;
	repo: string;
	repo_removed: boolean;
	payload: Record<string, unknown> | null;
	revision: number | null;
	updated_at: string | null;
	updated_by: string | null;
};
export type RepoAgentStateSummary = {
	revision: number;
	updated_at: string;
	summary: string | null;
	status: AgentStateStatus | null;
};
const jsonObject = z.record(z.string(), z.json());
function boundedJsonObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const pending = [{ value, depth: 1 }];
	while (pending.length) {
		const current = pending.pop();
		if (!current) break;
		if (current.depth > REPO_AGENT_STATE_MAX_DEPTH) return false;
		for (const child of Object.values(current.value))
			if (child !== null && typeof child === "object")
				pending.push({ value: child, depth: current.depth + 1 });
	}
	return jsonObject.safeParse(value).success;
}
export const repoAgentStateWriteSchema = z.strictObject({
	revision: z.number().int().positive().optional(),
	payload: z.custom<Record<string, unknown>>(boundedJsonObject),
});
export type RepoAgentStateWrite = z.output<typeof repoAgentStateWriteSchema>;

export function agentStateSummary(payload: Record<string, unknown> | null): {
	summary: string | null;
	status: AgentStateStatus | null;
} {
	const summary = payload?.summary;
	const status = payload?.status;
	return {
		summary: typeof summary === "string" && summary.length <= 200 ? summary : null,
		status: status === "ok" || status === "attention" || status === "blocked" ? status : null,
	};
}
