import { safeDiagnostics } from "./diagnostics.ts";
import { WorkTransportError } from "./github.ts";

export type WorkReviewState = { round: number; findings: string[]; head: string | null };

export async function reviewWork(options: {
	load: () => Promise<WorkReviewState>;
	save: (state: WorkReviewState) => Promise<unknown>;
	fix: (round: number, findings: string[]) => Promise<void>;
	check: () => Promise<string>;
	review: (head: string, round: number) => Promise<{ head: string; findings: string[] }>;
	signal?: AbortSignal;
}): Promise<string> {
	const state = { ...(await options.load()) };
	if (state.head && !state.findings.length) {
		if ((await options.check()) === state.head) return state.head;
		state.head = null;
		state.findings = ["Checked HEAD changed since independent approval."];
		await options.save(state);
	}
	while (state.round < 20) {
		if (options.signal?.aborted) throw new Error("Work cancelled.");
		state.round++;
		state.head = null;
		await options.save(state);
		try {
			await options.fix(state.round, state.findings);
			const head = await options.check();
			const review = await options.review(head, state.round);
			state.findings =
				review.head === head ? review.findings : ["Reviewer did not approve the checked HEAD."];
			if (!state.findings.length) {
				state.head = head;
				await options.save(state);
				return head;
			}
		} catch (error) {
			if (error instanceof WorkTransportError || options.signal?.aborted) {
				state.round--;
				await options.save(state);
				throw error;
			}
			state.findings = [
				safeDiagnostics(error instanceof Error ? error.message : "Work round failed."),
			];
		}
		await options.save(state);
	}
	throw new Error("20 rounds exhausted; no publication authorized.");
}
