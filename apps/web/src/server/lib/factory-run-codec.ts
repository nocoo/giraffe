import type { FactoryRun, FactoryRunStep } from "../../lib/factory-run";

const defaults = {
	attempts: 0,
	startedAt: null,
	finishedAt: null,
	durationMs: 0,
	pages: 0,
	error: null,
} satisfies Partial<FactoryRunStep>;

export function encodeRun(run: FactoryRun): string {
	return JSON.stringify({
		...run,
		steps: run.steps.map((step) =>
			Object.fromEntries(
				Object.entries(step).filter(
					([key, value]) => !(key in defaults) || value !== defaults[key as keyof typeof defaults],
				),
			),
		),
	});
}

export function decodeRun(payload: string): FactoryRun {
	const run = JSON.parse(payload) as FactoryRun;
	return { ...run, steps: run.steps?.map((step) => ({ ...defaults, ...step })) ?? [] };
}
