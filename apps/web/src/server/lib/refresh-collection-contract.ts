import type { RefreshDay, RefreshRun } from "../../lib/refresh-types";
import type { Env } from "../env";
import type { AccountRow } from "./db/accounts";

export type CollectionContext = {
	env: Env;
	account: AccountRow;
	token: string;
	run: RefreshRun;
	days: RefreshDay[];
	now: string;
	onRequests?: (count: number) => void;
};
export type CollectionResult = { requests: number; partial: boolean };
export type AccountCollectionResult = CollectionResult & { repos: string[] };
