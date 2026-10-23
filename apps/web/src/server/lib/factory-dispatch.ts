import type { Env } from "../env";
import { createDb } from "./db/d1";
import { dispatchRunState, dueRuns, expireRuns } from "./db/factory-runs";
import { executeRunPage } from "./factory-execute";
import { logFactory } from "./factory-log";
import { pruneFactory } from "./factory-retention";
import { scheduleRefreshes } from "./refresh-schedule";

const QUEUE_RETRY_DELAYS_MS = [500, 1000, 2000];

function isQueueOverloaded(error: unknown): boolean {
	if (typeof error === "string") return /\b(?:10250|429)\b/.test(error);
	if (!error || typeof error !== "object") return false;
	const { code, status, statusCode, message } = error as {
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
		message?: unknown;
	};
	return (
		[code, status, statusCode].some(
			(value) => value === 10250 || value === "10250" || value === 429 || value === "429",
		) ||
		(typeof message === "string" && /\b(?:10250|429)\b/.test(message))
	);
}

export async function enqueueRun(
	env: Env,
	id: string,
	at = new Date().toISOString(),
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const delay = Math.min(43200, Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000)));
			await env.FACTORY_QUEUE.send({ id }, { delaySeconds: delay });
			return;
		} catch (error) {
			const retryDelayMs = isQueueOverloaded(error) ? QUEUE_RETRY_DELAYS_MS[attempt] : undefined;
			logFactory(
				"factory_queue_send_error",
				{ runId: id, attempt: attempt + 1, retryDelayMs: retryDelayMs ?? null },
				error,
			);
			if (retryDelayMs === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
}
export async function handoffAccount(env: Env, account: string): Promise<void> {
	await scheduleRefreshes(env.DB, new Date().toISOString(), account, () =>
		new Date().toISOString(),
	);
	for (const successor of await dueRuns(createDb(env.DB), new Date().toISOString(), account))
		await enqueueRun(env, successor);
}
export async function consumeFactory(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;
		const id = body && typeof body === "object" && "id" in body ? body.id : null;
		if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
			message.ack();
			continue;
		}
		try {
			const next = await executeRunPage(env, id);
			if (next) await enqueueRun(env, id, next);
			else {
				const finished = await dispatchRunState(createDb(env.DB), id);
				if (finished && !["running", "paused"].includes(finished.status)) {
					await handoffAccount(env, finished.account_id);
				}
			}
			message.ack();
		} catch (error) {
			const attempt = message.attempts ?? 1;
			const delaySeconds = Math.min(15, 5 * 2 ** Math.max(0, attempt - 1));
			logFactory(
				"factory_consume_error",
				{ runId: id, attempt, retryDelaySeconds: delaySeconds },
				error,
			);
			message.retry({ delaySeconds });
		}
	}
}
/** D1 is the durable outbox: missing messages and expired leases are redispatched every minute. */
export async function continueFactory(env: Env, scheduledTime: number): Promise<void> {
	try {
		await expireRuns(createDb(env.DB), new Date().toISOString());
		await scheduleRefreshes(env.DB, new Date().toISOString(), "", () => new Date().toISOString());
		const ids = await dueRuns(createDb(env.DB), new Date().toISOString());
		for (const id of ids) await enqueueRun(env, id);
	} catch (error) {
		logFactory("factory_continue_error", { scheduledTime, phase: "dispatch" }, error);
		throw error;
	} finally {
		if (new Date(scheduledTime).getUTCMinutes() === 0) {
			await pruneFactory(createDb(env.DB), new Date().toISOString()).catch((error: unknown) => {
				logFactory("factory_continue_error", { scheduledTime, phase: "retention" }, error);
				throw error;
			});
		}
	}
}
