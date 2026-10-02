import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { CronExpressionParser } from "cron-parser";
import { digest } from "./evidence.ts";
import type { CronStatus } from "./repair-contracts.ts";

export function nextOccurrence(expression: string, timezone: string, after: string): string {
	if (expression.trim().split(/\s+/).length !== 5 || /H|@/.test(expression))
		throw new Error("Use a deterministic five-field cron expression.");
	new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
	const next = CronExpressionParser.parse(expression, { tz: timezone, currentDate: after })
		.next()
		.toISOString();
	if (!next) throw new Error("Cron has no future occurrence.");
	return next;
}
type CronState = {
	expression: string;
	timezone: string;
	nextRunAt: string;
	lastRunAt: string | null;
	active: string | null;
	completed: number;
	lastError: string | null;
};
const Schedule = defineDoc<CronState>({
	kind: "giraffe.repair-schedule",
	version: 1,
	scope: "session",
	initial: () => ({
		expression: "",
		timezone: "",
		nextRunAt: "",
		lastRunAt: null,
		active: null,
		completed: 0,
		lastError: null,
	}),
});
const context = BACKGROUND_CONTEXT;

export async function createCron(options: {
	harness: Harness;
	expression: string;
	timezone: string;
	enabled: boolean;
	maxRounds: number;
	run: (occurrence: string, signal: AbortSignal) => Promise<void>;
	publish: (status: CronStatus) => Promise<void>;
	isPaused: () => Promise<boolean>;
	now?: () => string;
	log?: (message: string) => void;
}) {
	const now = options.now ?? (() => new Date().toISOString());
	const log = options.log ?? (() => {});
	const initialNext = nextOccurrence(options.expression, options.timezone, now());
	await options.harness.commit(async (tx) => {
		const state = await tx.doc(Schedule);
		if (
			!state.active &&
			(state.expression !== options.expression || state.timezone !== options.timezone)
		) {
			state.expression = options.expression;
			state.timezone = options.timezone;
			state.nextRunAt = initialNext;
		}
	}, context);
	let stateName: CronStatus["state"] = "idle";
	let running = false;
	let paused = false;
	const publish = async () => {
		const state = await options.harness.snapshot(Schedule, context);
		if (!state) throw new Error("Cron state missing.");
		await options.publish({
			schemaVersion: 1,
			expression: state.expression,
			timezone: state.timezone,
			enabled: options.enabled,
			paused,
			state: stateName,
			nextRunAt: state.nextRunAt,
			lastRunAt: state.lastRunAt,
			activeOccurrence: state.active,
			lastSeenAt: now(),
			completed: state.completed,
			lastError: state.lastError,
			capability: "dependency-upgrades",
			maxRounds: options.maxRounds,
		});
	};
	return {
		async tick(signal = new AbortController().signal, force = false) {
			if (running || signal.aborted) return;
			running = true;
			try {
				paused = await options.isPaused();
				if (!options.enabled || paused) {
					await publish();
					return;
				}
				const instant = now();
				const occurrence = await options.harness.commit(async (tx) => {
					const state = await tx.doc(Schedule);
					if (state.active) return state.active;
					if (!force && Date.parse(state.nextRunAt) > Date.parse(instant)) return null;
					const due = force ? instant : state.nextRunAt;
					state.active = `cron-${digest({ due, expression: state.expression, timezone: state.timezone }).slice(0, 40)}`;
					state.lastRunAt = instant;
					state.lastError = null;
					return state.active;
				}, context);
				if (!occurrence) {
					await publish();
					return;
				}
				stateName = "running";
				await publish();
				try {
					await options.run(occurrence, signal);
					paused = await options.isPaused();
					if (signal.aborted || paused) return;
					await options.harness.commit(async (tx) => {
						const state = await tx.doc(Schedule);
						state.active = null;
						state.completed++;
						state.lastError = null;
						state.expression = options.expression;
						state.timezone = options.timezone;
						state.nextRunAt = nextOccurrence(state.expression, state.timezone, now());
					}, context);
					stateName = "idle";
				} catch {
					if (signal.aborted) return;
					stateName = "error";
					await options.harness.commit(async (tx) => {
						(await tx.doc(Schedule)).lastError = "repair_cycle_failed";
					}, context);
					log("修复周期失败，保留同一执行编号等待恢复。");
				}
				await publish();
			} finally {
				running = false;
			}
		},
		publish,
		async serve(signal: AbortSignal) {
			let inFlight = false;
			const timer = setInterval(() => {
				if (inFlight) return;
				inFlight = true;
				void publish()
					.catch(() => log("修复调度状态暂时无法上报。"))
					.finally(() => {
						inFlight = false;
					});
			}, 10000);
			try {
				while (!signal.aborted) {
					try {
						await this.tick(signal);
					} catch {
						log("修复调度连接失败，将在下一周期重试。");
					}
					if (!signal.aborted) await sleep(15000, undefined, { signal }).catch(() => {});
				}
			} finally {
				clearInterval(timer);
				stateName = "offline";
				await publish().catch(() => {});
			}
		},
	};
}
