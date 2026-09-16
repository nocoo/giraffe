import type { Env } from "../env";
import { createDb } from "./db/d1";
import { dueRuns } from "./db/factory-runs";
import { executeRunPage } from "./factory-execute";

export async function enqueueRun(
	env: Env,
	id: string,
	at = new Date().toISOString(),
): Promise<void> {
	const delay = Math.min(43200, Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000)));
	await env.FACTORY_QUEUE.send({ id }, { delaySeconds: delay });
}
export async function consumeFactory(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		if (
			!message.body ||
			typeof message.body !== "object" ||
			!("id" in message.body) ||
			typeof message.body.id !== "string" ||
			!/^[a-zA-Z0-9_-]{1,80}$/.test(message.body.id)
		) {
			message.ack();
			continue;
		}
		try {
			const next = await executeRunPage(env, message.body.id);
			if (next) await enqueueRun(env, message.body.id, next);
			message.ack();
		} catch {
			message.retry({ delaySeconds: 120 });
		}
	}
}
/** D1 is the durable outbox: missing messages and expired leases are redispatched every minute. */
export async function continueFactory(env: Env): Promise<void> {
	const ids = await dueRuns(createDb(env.DB), new Date().toISOString());
	for (const id of ids) await enqueueRun(env, id);
}
