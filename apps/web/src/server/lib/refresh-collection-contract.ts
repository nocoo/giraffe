import type {
	RefreshDay,
	RefreshFailureDetail,
	RefreshMetricGuardEvent,
	RefreshRun,
} from "../../lib/refresh-types";
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
	onMetricGuard?: (event: RefreshMetricGuardEvent) => void;
	/** When false, persist pending writes but skip factory/aggregate publication head. */
	publishFactorySnapshot?: boolean;
};
export type CollectionResult = {
	requests: number;
	requestBreakdown: RequestBreakdown;
	partial: boolean;
	reasons: string[];
};
export type AccountCollectionResult = CollectionResult & { repos: string[]; aReused?: boolean };
