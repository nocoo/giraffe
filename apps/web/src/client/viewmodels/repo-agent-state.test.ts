// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { agentStatePresentation, loadRepoAgentState } from "./repo-agent-state";
import { setActiveAccountId } from "./session";

afterEach(() => {
	setActiveAccountId(null);
	vi.unstubAllGlobals();
});

it("R5 reads agent state through the account-fenced browser API without writes", async () => {
	setActiveAccountId("a");
	const state = {
		account_id: "a",
		repo: "owner/app",
		repo_removed: false,
		revision: 2,
		payload: { summary: "Ready", status: "ok" },
		updated_at: "2026-10-22T00:00:00Z",
		updated_by: "agent",
	};
	const accounts = () =>
		Response.json({ accounts: [{ id: "a", login: "owner", is_active: true }] });
	const fetcher = vi.fn(async (input: RequestInfo | URL) =>
		String(input) === "/api/accounts" ? accounts() : Response.json(state),
	);
	vi.stubGlobal("fetch", fetcher);
	expect(await loadRepoAgentState("owner", "app")).toEqual(state);
	expect(fetcher.mock.calls[1]?.[0]).toBe("/api/repos/owner/app/agent-state");
	expect(await loadRepoAgentState("..", "app")).toEqual({ missing: true });
	expect(fetcher).toHaveBeenCalledTimes(2);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
		String(input) === "/api/accounts"
			? accounts()
			: Response.json(
					{ error: { code: "not_found", message: "Unknown repository" } },
					{ status: 404 },
				),
	);
	expect(await loadRepoAgentState("owner", "missing")).toEqual({ missing: true });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
		String(input) === "/api/accounts"
			? accounts()
			: Response.json({ error: { code: "db_error", message: "Unavailable" } }, { status: 500 }),
	);
	await expect(loadRepoAgentState("owner", "app")).rejects.toMatchObject({ status: 500 });
});

it("R5 presents only bounded summary, known status and valid review dates", () => {
	expect(
		agentStatePresentation({
			summary: "Review needed",
			status: "attention",
			last_reviewed_at: "2026-10-22T00:00:00Z",
		}),
	).toMatchObject({
		summary: "Review needed",
		status: "attention",
		label: "需关注",
		tone: "amber",
		lastReviewedAt: "2026-10-22T00:00:00Z",
	});
	expect(agentStatePresentation({ status: "ok" })).toMatchObject({ label: "正常", tone: "green" });
	expect(agentStatePresentation({ status: "blocked" })).toMatchObject({
		label: "阻塞",
		tone: "rose",
	});
	expect(
		agentStatePresentation({
			summary: "x".repeat(201),
			status: "unknown",
			last_reviewed_at: "not a date",
		}),
	).toMatchObject({ summary: null, status: null, lastReviewedAt: null });
	expect(agentStatePresentation(null)).toMatchObject({
		summary: null,
		status: null,
		lastReviewedAt: null,
	});
});
