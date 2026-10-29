import type { RefreshDay, RefreshFailureDetail, RefreshRun } from "../../lib/refresh-types";
import type { Env } from "../env";
import type { AccountRow } from "./db/accounts";

export type RequestBreakdown = { graphql: number; rest: number };
export type CollectionContext = {
	env: Env;
	account: AccountRow;
	token: string;
	run: RefreshRun;
	days: RefreshDay[];
	now: string;
	onRequests?: (count: number, breakdown: RequestBreakdown) => void;
	onFailures?: (failures: RefreshFailureDetail[]) => void;
};
export type CollectionResult = {
	requests: number;
	requestBreakdown: RequestBreakdown;
	partial: boolean;
	reasons: string[];
};
export type AccountCollectionResult = CollectionResult & { repos: string[]; aReused?: boolean };
