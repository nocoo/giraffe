import type { RepoAssessment } from "../../lib/repo-assessment";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { isValidRepoPart } from "./repo-detail";
import { cacheGeneration, ensureSession, getActiveAccountId } from "./session";

export async function loadRepoAssessment(
	owner: string,
	name: string,
): Promise<RepoAssessment | { missing: true }> {
	if (!isValidRepoPart(owner) || !isValidRepoPart(name)) return { missing: true };
	const account = await ensureSession();
	const generation = cacheGeneration();
	try {
		const assessment = await apiGet<RepoAssessment>(`repos/${owner}/${name}/assessment`);
		if (generation !== cacheGeneration() || account !== getActiveAccountId()) {
			return { missing: true };
		}
		if (assessment.account_id !== account) {
			await ensureSession();
			return { missing: true };
		}
		return assessment;
	} catch (error) {
		if (generation !== cacheGeneration() || account !== getActiveAccountId()) {
			return { missing: true };
		}
		if (error instanceof ApiError && (error.status === 404 || error.code === "snapshot_missing")) {
			return { missing: true };
		}
		throw error;
	}
}

export function assessmentPending(status: RepoAssessment["status"]): boolean {
	return status === "judgment" || status === "summary";
}

export function assessmentStale(assessment: RepoAssessment): boolean {
	return (
		assessment.report !== null &&
		(assessment.reportVersion !== assessment.sourceVersion || assessment.status === "failed")
	);
}

export function prioritizedActions(
	actions: NonNullable<RepoAssessment["report"]>["actions"],
): NonNullable<RepoAssessment["report"]>["actions"] {
	const order = { now: 0, next: 1, later: 2 };
	return [...actions].sort((a, b) => order[a.priority] - order[b.priority]);
}
