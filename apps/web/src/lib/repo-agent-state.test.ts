import { expect, it } from "vitest";
import { agentStateSummary, repoAgentStateWriteSchema } from "./repo-agent-state";

it.each([
	[null, { summary: null, status: null }],
	[{}, { summary: null, status: null }],
	[
		{ summary: "reviewed", status: "attention", arbitrary: { retained: true } },
		{ summary: "reviewed", status: "attention" },
	],
	[
		{ summary: "x".repeat(200), status: "ok" },
		{ summary: "x".repeat(200), status: "ok" },
	],
	[
		{ summary: "x".repeat(201), status: "blocked" },
		{ summary: null, status: "blocked" },
	],
	[
		{ summary: 42, status: "other" },
		{ summary: null, status: null },
	],
	[
		{ summary: [], status: { value: "ok" }, last_reviewed_at: "not interpreted" },
		{ summary: null, status: null },
	],
] as const)("R5 extracts only valid summary/status from %j", (payload, expected) => {
	expect(agentStateSummary(payload)).toEqual(expected);
});

it("R5 write schema preserves arbitrary JSON fields without interpreting them", () => {
	const input = {
		revision: 2,
		payload: {
			summary: "x".repeat(201),
			status: "custom",
			last_reviewed_at: { any: "JSON" },
			memory: [null, true, 12],
		},
	};
	expect(repoAgentStateWriteSchema.parse(input)).toEqual(input);
	expect(repoAgentStateWriteSchema.parse({ payload: {} })).toEqual({ payload: {} });
});

it.each([
	null,
	[],
	{},
	{ payload: null },
	{ payload: [] },
	{ payload: "text" },
	{ payload: {}, revision: 0 },
	{ payload: {}, revision: 1.2 },
	{ payload: {}, revision: "1" },
	{ payload: {}, unknown: true },
])("R5 write schema rejects malformed envelopes %j", (input) =>
	expect(repoAgentStateWriteSchema.safeParse(input).success).toBe(false),
);

it("R5 validation preserves own opaque __proto__ keys at every JSON level", () => {
	const input = JSON.parse(
		'{"payload":{"ordinary":"keep","__proto__":{"note":"opaque"},"nested":{"__proto__":"also opaque"}}}',
	);
	const parsed = repoAgentStateWriteSchema.parse(input);
	expect(parsed.payload).toBe(input.payload);
	expect(JSON.stringify(parsed.payload)).toBe(JSON.stringify(input.payload));
	expect(Object.hasOwn(parsed.payload, "__proto__")).toBe(true);
	expect(Object.getPrototypeOf(parsed.payload)).toBe(Object.prototype);
});

it.each([64, 65, 1001])(
	"R5 payload container depth %i uses a bounded application limit before recursive JSON parsing",
	(depth) => {
		const payload = JSON.parse(`${'{"x":'.repeat(depth)}null${"}".repeat(depth)}`);
		expect(repoAgentStateWriteSchema.safeParse({ payload }).success).toBe(depth === 64);
	},
);

it("R5 depth validation counts arrays as containers and terminates safely for cycles", () => {
	const nested = (depth: number) => {
		let value: unknown = null;
		for (let i = 1; i < depth; i++) value = i % 2 ? [value] : { x: value };
		return { x: value };
	};
	expect(repoAgentStateWriteSchema.safeParse({ payload: nested(64) }).success).toBe(true);
	expect(repoAgentStateWriteSchema.safeParse({ payload: nested(65) }).success).toBe(false);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	expect(repoAgentStateWriteSchema.safeParse({ payload: cyclic }).success).toBe(false);
});
