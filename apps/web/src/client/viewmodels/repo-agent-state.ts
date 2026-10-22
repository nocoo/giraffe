import { agentStateSummary, type RepoAgentState } from "../../lib/repo-agent-state";
import { ApiError } from "../lib/errors";
import type { CandyTone } from "../lib/format";
import { isValidRepoPart } from "./repo-detail";
import { loadKind } from "./snapshot";

export async function loadRepoAgentState(
	owner: string,
	name: string,
): Promise<RepoAgentState | { missing: true }> {
	if (!isValidRepoPart(owner) || !isValidRepoPart(name)) return { missing: true };
	try {
		return await loadKind<RepoAgentState>(`repos/${owner}/${name}/agent-state`);
	} catch (error) {
		if (error instanceof ApiError && error.code === "not_found") return { missing: true };
		throw error;
	}
}

export function agentStatePresentation(payload: Record<string, unknown> | null) {
	const summary = agentStateSummary(payload);
	const styles = {
		ok: { label: "正常", tone: "green" },
		attention: { label: "需关注", tone: "amber" },
		blocked: { label: "阻塞", tone: "rose" },
	} satisfies Record<string, { label: string; tone: CandyTone }>;
	const reviewed = payload?.last_reviewed_at;
	return {
		...summary,
		...(summary.status ? styles[summary.status] : { label: "未标记", tone: "gray" as CandyTone }),
		lastReviewedAt:
			typeof reviewed === "string" && Number.isFinite(Date.parse(reviewed)) ? reviewed : null,
	};
}
