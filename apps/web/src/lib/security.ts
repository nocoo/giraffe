import type { UnavailableReasonCode } from "./factory-types";

export type SecurityFeature = {
	status: "available" | "unavailable" | "partial";
	reason_code: UnavailableReasonCode | null;
	reason: string | null;
};
export type SecurityFeatures = Record<"dependabot" | "code_scanning", SecurityFeature>;
export type RetainedSecurity = Partial<
	Record<
		keyof SecurityFeatures,
		{
			open: number;
			fetched_at: string;
			items: Record<string, unknown>[];
		}
	>
>;
export type SecuritySnapshot = {
	features?: SecurityFeatures;
	unavailable: boolean;
	truncated: boolean;
	dependabot_open: number | null;
	code_scanning_open: number | null;
};

export function retainSecurity(
	previous: Record<string, unknown> | null,
	current: SecurityFeatures,
) {
	const retained: RetainedSecurity = {};
	if (!previous || previous.truncated) return retained;
	const features = previous.features as SecurityFeatures | undefined;
	const prior = previous.retained as RetainedSecurity | undefined;
	for (const feature of ["dependabot", "code_scanning"] as const) {
		if (current[feature].status !== "unavailable") continue;
		const count = previous[`${feature}_open`];
		if (
			(features ? features[feature].status === "available" : !previous.unavailable) &&
			typeof count === "number" &&
			typeof previous.fetched_at === "string"
		) {
			retained[feature] = {
				open: count,
				fetched_at: previous.fetched_at,
				items: Array.isArray(previous.items)
					? previous.items.filter((item) => item.source === feature)
					: [],
			};
		} else if (prior?.[feature]) retained[feature] = prior[feature];
	}
	return retained;
}

export function securityCount(snapshot: SecuritySnapshot, feature: keyof SecurityFeatures) {
	const coverage = snapshot.features?.[feature];
	const count = snapshot[`${feature}_open`];
	if (coverage?.status === "unavailable") return null;
	if (coverage?.status === "available") return count;
	if ((coverage?.status === "partial" || snapshot.unavailable || snapshot.truncated) && !count)
		return null;
	return count;
}

export function securityIncomplete(snapshot: Record<string, unknown> | null) {
	const features = snapshot?.features as SecurityFeatures | undefined;
	return (
		!snapshot ||
		snapshot.unavailable === true ||
		snapshot.truncated === true ||
		(features !== undefined &&
			Object.values(features).some((feature) => feature.status !== "available"))
	);
}
