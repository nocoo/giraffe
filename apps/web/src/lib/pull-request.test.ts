import { expect, it } from "vitest";
import { prLifecycleState, prSnapshot, prState } from "./pull-request";

it("preserves unknown lifecycle values and accepts saved REST and GraphQL merge timestamps", () => {
	for (const value of [null, [], 1, {}, { state: "unknown" }, { state: 1 }])
		expect(prLifecycleState(value)).toBeNull();
	expect(prLifecycleState({ mergedAt: "", merged_at: "saved", state: "closed" })).toBe("merged");
	expect(prLifecycleState({ mergedAt: "saved" })).toBe("merged");
	for (const state of ["OPEN", "CLOSED", "MERGED"])
		expect(prLifecycleState({ state })).toBe(state.toLowerCase());
});

it.each(["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"])(
	"projects saved check rollup %s without an upstream request",
	(state) => {
		expect(
			prState({
				commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
			}),
		).toEqual({ mergeable: true, mergeStateStatus: "CLEAN", checks: { state } });
	},
);

it("keeps explicit nullable merge and check evidence instead of synthesizing readiness", () => {
	for (const mergeable of [true, false, "CONFLICTING", "UNKNOWN"])
		expect(prState({ mergeable, mergeStateStatus: "", checks: { state: "unknown" } })).toEqual({
			mergeable:
				mergeable === "CONFLICTING" ? false : typeof mergeable === "boolean" ? mergeable : null,
			mergeStateStatus: null,
			checks: { state: null },
		});
	expect(prState(null)).toEqual({
		mergeable: null,
		mergeStateStatus: null,
		checks: { state: null },
	});
	const source = { pull_requests: [{ state: "CLOSED", merged_at: "saved" }, null] };
	expect(prSnapshot(source, { lifecycle: true })).toMatchObject({
		pull_requests: [{ state: "merged" }, { state: null }],
	});
	expect(prSnapshot(source)).toMatchObject({ pull_requests: [{ state: "CLOSED" }, {}] });
	const other = { issues: [] };
	expect(prSnapshot(other)).toBe(other);
});
