import { afterEach, expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import type { Domain } from "./contracts.ts";
import { decisionClient } from "./decision.ts";
import type { AnalysisInput } from "./evidence.ts";
import { JEV_MAX_REQUEST_BYTES } from "./jev-input.ts";

const config = configSchema.parse({
	providers: {
		model: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fake" },
		jev: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "fake" },
	},
	roles: {
		orchestrator: { provider: "model", model: "fake" },
		executor: { provider: "model", model: "fake" },
		decision: { provider: "jev", model: "jev" },
	},
});
const input = (domain: Domain): AnalysisInput => ({
	domain,
	scope: "repo",
	repository: "owner/repo",
	sourceVersion: "v",
	observedAt: "now",
	sources: [{ resource: "issues", version: null, fetchedAt: null, complete: false, stale: true }],
	counts: Object.fromEntries(
		Array.from({ length: 40 }, (_, index) => [`${index}${"界".repeat(500)}`, index]),
	),
	limitations: Array.from({ length: 10 }, () => '😀"\\\n'.repeat(300)),
	evidence: Array.from({ length: 10 }, (_, index) => ({
		id: `source:${index}`,
		repository: "owner/repo",
		kind: "issue",
		title: "😀".repeat(500),
		state: "界".repeat(300),
		detail: '😀"\\\n'.repeat(500),
		url: null,
		at: null,
	})),
	omitted: 7,
});
afterEach(() => vi.unstubAllGlobals());

it("splits all domains by wire bytes, bounds projections without mutation and propagates abort", async () => {
	const inputs = (["issues", "prs", "ci", "cd"] as const).map(input);
	const before = structuredClone(inputs);
	const controller = new AbortController();
	const domains: string[] = [];
	const send = vi.fn<typeof fetch>(async (_url, init) => {
		expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("jev");
		for (const state of body.state) {
			domains.push(state.domain);
			expect(state.counts).toHaveLength(16);
			expect(state.countsOmitted).toBe(24);
			expect(state.counts[0].key).toContain("clipped");
			expect(state.limitations).toHaveLength(4);
			expect(state.limitationsOmitted).toBe(6);
			expect(state.evidence).toHaveLength(8);
			expect(state.evidenceOmitted).toBe(9);
			expect(state.sources).toEqual({ total: 1, missing: 1, stale: 1 });
			expect(state.evidence[0].id).toBe("source:0");
			expect(state.evidence[0].state).toContain("clipped");
		}
		expect(init?.signal?.aborted).toBe(false);
		return Response.json({
			model: "jev-answer",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: Object.fromEntries(
				Object.keys(body.questions).map((domain) => [
					domain,
					{
						type: "choice",
						choice: "unknown",
						confidence: 1,
						probabilities: { unknown: 1, routine: 0, review: 0, urgent: 0 },
					},
				]),
			),
		});
	});
	vi.stubGlobal("fetch", send);
	const results = await decisionClient(config)(inputs, controller.signal);
	expect(domains).toEqual(["issues", "prs", "ci", "cd"]);
	expect(Object.values(results).map((result) => result?.model)).toEqual(
		Array(4).fill("jev-answer"),
	);
	expect(inputs).toEqual(before);
	expect(send.mock.calls.length).toBeGreaterThan(2);
	send.mockImplementation(async (_url, init) => {
		controller.abort();
		expect(init?.signal?.aborted).toBe(true);
		throw new DOMException("Aborted", "AbortError");
	});
	await expect(decisionClient(config)(inputs, controller.signal)).rejects.toThrow();
	await expect(decisionClient(config)(inputs, controller.signal)).rejects.toThrow();
});

it("preflights all domains, preserves mandatory identities and avoids empty calls", async () => {
	const send = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", send);
	const decide = decisionClient(config);
	expect(await decide([])).toEqual({});
	const small = { ...input("issues"), counts: {}, limitations: [], evidence: [] };
	const large = {
		...input("ci"),
		evidence: [
			{ ...(input("ci").evidence[0] as AnalysisInput["evidence"][number]), id: "x".repeat(17000) },
		],
	};
	await expect(decide([small, large])).rejects.toThrow(/domain.*ci.*owner\/repo.*bytes.*16384/);
	await expect(decide([{ ...large, repository: null, scope: "global" }])).rejects.toThrow(
		/ci global/,
	);
	expect(send).not.toHaveBeenCalled();
});

it("rejects missing, wrong-type and invalid distributions from the SDK", async () => {
	const send = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", send);
	const decide = decisionClient(config);
	for (const answers of [
		{},
		{ issues: { type: "noul", value: true } },
		{
			issues: {
				type: "choice",
				choice: "unknown",
				confidence: 1,
				probabilities: { unknown: 0, urgent: 0, review: 0, routine: 0 },
			},
		},
	]) {
		send.mockResolvedValueOnce(
			Response.json({ model: "fake", usage: { input_tokens: 1, output_tokens: 1 }, answers }),
		);
		await expect(
			decide([{ ...input("issues"), evidence: [], counts: {}, limitations: [] }]),
		).rejects.toThrow();
	}
});
