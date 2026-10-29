import type { RefreshRun } from "../lib/refresh-types";
import type { Db } from "./lib/db/d1";
import { requestRefreshCancel } from "./lib/refresh-store";

export type CancelRefreshInput = {
	db: Db;
	accountId: string;
	id: string;
	at: string;
	wake: () => unknown;
	waitUntil: (work: Promise<unknown>) => void;
};

const settle = () => undefined;

export async function requestCancellation(input: CancelRefreshInput): Promise<RefreshRun | null> {
	const { db, accountId, id, at } = input;
	const { run, requested } = await requestRefreshCancel(db, accountId, id, at);
	if (!run || !requested) return run;
	input.waitUntil(Promise.resolve().then(input.wake).then(settle, settle));
	return run;
}
