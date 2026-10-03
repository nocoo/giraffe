import { z } from "zod";

const runSchema = z.object({
	head_sha: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	name: z.string().default(""),
});
export type FollowUpState = {
	checks: number;
	nextAt: number;
	outcome: "pending" | "passed" | "failed" | "timeout";
	runs: z.infer<typeof runSchema>[];
	expected?: string[];
};

export async function followUp(options: {
	sha: string;
	state: FollowUpState;
	now: () => number;
	wait: (ms: number) => Promise<unknown>;
	read: () => Promise<unknown>;
	save: (state: FollowUpState) => Promise<unknown>;
	signal?: AbortSignal;
}) {
	const { state } = options;
	if (state.checks >= 3 && state.outcome === "pending") {
		state.outcome = "timeout";
		await options.save(structuredClone(state));
	}
	while (state.checks < 3 && state.outcome === "pending") {
		if (options.signal?.aborted) return;
		await options.wait(Math.max(0, state.nextAt - options.now()));
		if (options.signal?.aborted) return;
		state.checks++;
		state.nextAt = options.now() + 600000;
		await options.save(structuredClone(state));
		try {
			const result = z
				.object({ workflow_runs: z.array(runSchema).max(100), total_count: z.number().optional() })
				.parse(await options.read());
			state.runs = result.workflow_runs.filter((run) => run.head_sha === options.sha);
			if (
				state.runs.some(
					(run) =>
						run.status === "completed" &&
						["failure", "timed_out", "action_required"].includes(run.conclusion ?? ""),
				)
			)
				state.outcome = "failed";
			else if (
				state.runs.length &&
				(state.expected?.length ?? 0) > 0 &&
				state.expected?.every((name) => state.runs.some((run) => run.name === name)) &&
				(result.total_count ?? result.workflow_runs.length) <= result.workflow_runs.length &&
				state.runs.every((run) => run.status === "completed" && run.conclusion === "success")
			)
				state.outcome = "passed";
		} catch {
			state.runs = [];
		}
		if (state.checks === 3 && state.outcome === "pending") state.outcome = "timeout";
		await options.save(structuredClone(state));
	}
}
