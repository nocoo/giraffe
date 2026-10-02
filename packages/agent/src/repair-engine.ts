import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import { gte, minVersion, satisfies, valid } from "semver";
import { digest } from "./evidence.ts";
import {
	type DependencyPlan,
	dependencyPlanSchema,
	type IssueCandidate,
	type LiveIssue,
	MAX_REPAIR_ROUNDS,
	type RepairProgress,
	type RepairReview,
	repairProgressSchema,
	repairReviewSchema,
} from "./repair-contracts.ts";
import { assertSameIssue, LiveStateChanged } from "./repair-source.ts";
import type {
	CheckReceipt,
	Workspace,
	WorkspaceDriver,
	WorkspaceSnapshot,
} from "./repair-workspace.ts";
import { WorkspaceError } from "./repair-workspace.ts";

type RepairState = {
	progress: RepairProgress;
	issue: LiveIssue | null;
	workspace: Workspace | null;
	checks: CheckReceipt | null;
	snapshot: WorkspaceSnapshot | null;
	workerDone: boolean;
	feedback: string;
	updatedDependency: boolean;
	grantVersion: string;
	prerequisiteBlocked: boolean;
};
const Repairs = defineDocFamily<
	RepairState,
	{ id: string; candidate: IssueCandidate; now: string; maxRounds: number }
>({
	kind: "giraffe.repairs",
	version: 1,
	scope: "session",
	family: true,
	initial: ({ id, candidate, now, maxRounds }) => ({
		progress: {
			schemaVersion: 1,
			id,
			repository: candidate.repository,
			issueNumber: candidate.number,
			title: candidate.title,
			issueUrl: candidate.url,
			stage: "discovered",
			round: 0,
			maxRounds,
			branch: null,
			head: null,
			contentFingerprint: null,
			workerConversationId: null,
			reviewerConversationId: null,
			startedAt: now,
			updatedAt: now,
			sequence: 0,
			reason: "Dependency issue discovered.",
			plan: null,
			review: null,
			events: [],
		},
		issue: null,
		workspace: null,
		checks: null,
		snapshot: null,
		workerDone: false,
		feedback: "",
		updatedDependency: false,
		grantVersion: "",
		prerequisiteBlocked: false,
	}),
	checkpointWhen: () => true,
});
const context = BACKGROUND_CONTEXT;
const TERMINAL = new Set(["pushed", "blocked", "exhausted", "cancelled"]);
export type RepairModels = {
	plan(issue: LiveIssue, files: Record<string, string>, requestId: string): Promise<DependencyPlan>;
	work(input: {
		issue: LiveIssue;
		plan: DependencyPlan;
		workspace: Workspace;
		round: number;
		feedback: string;
		requestId: string;
	}): Promise<{ conversationId: number; summary: string }>;
	review(input: {
		issue: LiveIssue;
		plan: DependencyPlan;
		snapshot: WorkspaceSnapshot;
		checks: CheckReceipt;
		round: number;
		requestId: string;
	}): Promise<{ conversationId: number; review: RepairReview }>;
};
export type RepairEngineOptions = {
	harness: Harness;
	driver: WorkspaceDriver;
	models: RepairModels;
	verify: (candidate: IssueCandidate, signal?: AbortSignal) => Promise<LiveIssue>;
	admit: (issue: LiveIssue) => Promise<{ eligible: boolean; reason: string }>;
	verifyPackage: (plan: DependencyPlan) => Promise<void>;
	publish: (progress: RepairProgress) => Promise<void>;
	isPaused: () => Promise<boolean>;
	maxRounds: number;
	allowPush: boolean;
	grantVersion?: string;
	prerequisite?: (candidate: IssueCandidate) => string | null;
	now?: () => string;
	log?: (message: string) => void;
};

export function assertReviewSignoff(
	review: RepairReview,
	snapshot: WorkspaceSnapshot,
	checks: CheckReceipt,
	round: number,
) {
	repairReviewSchema.parse(review);
	if (
		review.verdict !== "signoff" ||
		review.reviewedRound !== round ||
		review.head !== snapshot.head ||
		review.contentFingerprint !== snapshot.contentFingerprint ||
		review.validationDigest !== checks.validationDigest ||
		checks.contentFingerprint !== snapshot.contentFingerprint ||
		!snapshot.complete
	)
		throw new Error("Signoff does not match final checked code.");
}

export function assertDependencyOutcome(plan: DependencyPlan, snapshot: WorkspaceSnapshot): void {
	if (plan.manifest !== "package.json")
		throw new Error("Only root package manifests are supported initially.");
	const changes = snapshot.manifestBeforeAfter[plan.manifest];
	if (!changes?.before || !changes.after || !snapshot.changedPaths.includes(plan.manifest))
		throw new Error("Dependency manifest was not updated.");
	const before = JSON.parse(changes.before) as Record<string, Record<string, string>>;
	const after = JSON.parse(changes.after) as Record<string, Record<string, string>>;
	const original = before[plan.section]?.[plan.dependency];
	const updated = after[plan.section]?.[plan.dependency];
	if (
		!original ||
		!updated ||
		!valid(plan.targetVersion) ||
		!satisfies(plan.targetVersion, updated, { includePrerelease: true }) ||
		updated === original
	)
		throw new Error("Requested dependency target is not present in the final manifest.");
	if (!snapshot.changedPaths.some((path) => path === "package-lock.json" || path === "bun.lock"))
		throw new Error("A corresponding dependency lockfile change is required.");
}

export function assertDependencyPlan(
	plan: DependencyPlan,
	issue: LiveIssue,
	manifestText: string,
): void {
	if (plan.manifest !== "package.json")
		throw new Error("Only root npm/Bun dependency upgrades are supported.");
	const manifest = JSON.parse(manifestText) as Record<string, Record<string, string>>;
	const current = manifest[plan.section]?.[plan.dependency];
	const minimum = current ? minVersion(current) : null;
	if (!current || !minimum || !valid(plan.targetVersion) || gte(minimum, plan.targetVersion))
		throw new Error("Dependency is absent, unsupported or already at a newer version.");
	const request = `${issue.title}\n${issue.body}`;
	if (!request.includes(plan.dependency) || !request.includes(plan.targetVersion))
		throw new Error("The package and exact target must be evidenced by the live issue.");
}

export function createRepairEngine(options: RepairEngineOptions) {
	if (
		!Number.isInteger(options.maxRounds) ||
		options.maxRounds < 1 ||
		options.maxRounds > MAX_REPAIR_ROUNDS
	)
		throw new Error("Repair round limit must be 1..20.");
	const now = options.now ?? (() => new Date().toISOString());
	const log = options.log ?? (() => {});
	let running = false;
	const get = async (id: string) => {
		const value = await options.harness.snapshot(Repairs, id, context);
		if (!value) throw new Error("Repair state missing.");
		return value;
	};
	async function change(id: string, mutate: (state: RepairState) => void, message: string) {
		await options.harness.commit(async (tx) => {
			const state = await tx.doc(Repairs, id, {
				id,
				candidate: {} as IssueCandidate,
				now: now(),
				maxRounds: options.maxRounds,
			});
			mutate(state);
			state.progress.sequence++;
			state.progress.updatedAt = now();
			state.progress.reason = message.slice(0, 3000);
			state.progress.events.push({
				at: now(),
				stage: state.progress.stage,
				round: state.progress.round,
				message: message.slice(0, 2000),
			});
			state.progress.events = state.progress.events.slice(-80);
			while (
				new TextEncoder().encode(JSON.stringify(state.progress)).length > 60000 &&
				state.progress.events.length > 1
			)
				state.progress.events.shift();
		}, context);
		const state = await get(id);
		log(
			`[修复 ${state.progress.repository}#${state.progress.issueNumber}] ${state.progress.stage} ${state.progress.round}/${state.progress.maxRounds} ${message}`,
		);
		await options.publish(repairProgressSchema.parse(state.progress));
	}
	return {
		async trace(id: string, message: string) {
			await change(id, () => {}, message);
		},
		async state(id: string) {
			return (await get(id)).progress;
		},
		async run(
			candidate: IssueCandidate,
			signal = new AbortController().signal,
		): Promise<RepairProgress> {
			if (running) throw new Error("Only one dependency repair may run at a time.");
			running = true;
			const id = `deps-${candidate.number}-${digest({ repository: candidate.repository, number: candidate.number, updatedAt: candidate.updatedAt }).slice(0, 20)}`;
			try {
				await options.harness.commit(async (tx) => {
					await tx.doc(Repairs, id, { id, candidate, now: now(), maxRounds: options.maxRounds });
				}, context);
				let state = await get(id);
				const grant = options.grantVersion ?? "";
				if (
					state.progress.stage === "blocked" &&
					state.prerequisiteBlocked &&
					state.grantVersion !== grant
				) {
					await change(
						id,
						(value) => {
							value.progress.stage = "discovered";
							value.prerequisiteBlocked = false;
							value.grantVersion = grant;
						},
						"Local prerequisites changed; retrying without resetting review rounds.",
					);
					state = await get(id);
				}
				if (TERMINAL.has(state.progress.stage)) {
					await options.publish(state.progress);
					return state.progress;
				}
				if (signal.aborted) return state.progress;
				if (await options.isPaused()) return state.progress;
				const prerequisite = options.prerequisite?.(candidate);
				if (prerequisite) {
					await change(
						id,
						(value) => {
							value.progress.stage = "blocked";
							value.prerequisiteBlocked = true;
							value.grantVersion = grant;
						},
						prerequisite,
					);
					return (await get(id)).progress;
				}
				if (!state.issue) {
					let issue: LiveIssue;
					try {
						issue = await options.verify(candidate, signal);
					} catch (error) {
						if (!(error instanceof LiveStateChanged)) throw error;
						await change(
							id,
							(value) => {
								value.progress.stage = "cancelled";
							},
							error.message,
						);
						return (await get(id)).progress;
					}
					const admission = await options.admit(issue);
					await change(
						id,
						(value) => {
							value.issue = issue;
							value.progress.stage = admission.eligible ? "preparing" : "blocked";
						},
						admission.reason,
					);
					state = await get(id);
					if (!admission.eligible) return state.progress;
				}
				const issue = state.issue as LiveIssue;
				if (!state.workspace) {
					let prepared: Workspace;
					try {
						prepared = await options.driver.prepare({
							id,
							repository: issue.repository,
							baseSha: issue.baseSha,
							defaultBranch: issue.defaultBranch,
						});
					} catch {
						await change(
							id,
							(value) => {
								value.progress.stage = "blocked";
							},
							"Workspace preparation blocked; verify profile, hooks and isolation.",
						);
						return (await get(id)).progress;
					}
					await change(
						id,
						(value) => {
							value.workspace = prepared;
							value.progress.branch = prepared.branch;
							value.progress.stage = "planning";
						},
						"Isolated repair workspace prepared.",
					);
				}
				state = await get(id);
				const workspace = state.workspace as Workspace;
				await options.driver.prepare({
					id,
					repository: issue.repository,
					baseSha: issue.baseSha,
					defaultBranch: issue.defaultBranch,
				});
				if (!state.progress.plan) {
					const files: Record<string, string> = {};
					for (const path of [
						"package.json",
						"AGENTS.md",
						"README.md",
						"NOTICE",
						"CONTRIBUTING.md",
					]) {
						try {
							files[path] = await options.driver.readFile(workspace, path);
						} catch {
							files[path] = "Not available in the captured workspace.";
						}
					}
					const plan = dependencyPlanSchema.parse(
						await options.models.plan(issue, files, `${id}:plan`),
					);
					if (plan.decision === "repair" && plan.provenance === "original") {
						assertDependencyPlan(plan, issue, files["package.json"] ?? "{}");
						await options.verifyPackage(plan);
					}
					await change(
						id,
						(value) => {
							value.progress.plan = plan;
							value.progress.stage =
								plan.decision === "repair" && plan.provenance === "original" ? "fixing" : "blocked";
						},
						plan.reason,
					);
					if (plan.decision !== "repair" || plan.provenance !== "original")
						return (await get(id)).progress;
				}
				while (!signal.aborted) {
					state = await get(id);
					if (TERMINAL.has(state.progress.stage) || (await options.isPaused()))
						return state.progress;
					const plan = state.progress.plan as DependencyPlan;
					if (state.progress.stage === "signed_off" || state.progress.stage === "pushing") {
						if (!options.allowPush) return state.progress;
						let live: LiveIssue;
						try {
							live = await options.verify(candidate, signal);
						} catch (error) {
							if (!(error instanceof LiveStateChanged)) throw error;
							await change(
								id,
								(value) => {
									value.progress.stage = "cancelled";
								},
								error.message,
							);
							return (await get(id)).progress;
						}
						try {
							assertSameIssue(issue, live);
						} catch {
							await change(
								id,
								(value) => {
									value.progress.stage = "blocked";
								},
								"GitHub state changed after review; no push allowed.",
							);
							return (await get(id)).progress;
						}
						const snapshot = await options.driver.snapshot(workspace);
						const checks = await options.driver.check(workspace, {
							contentFingerprint: snapshot.contentFingerprint,
							signal,
						});
						try {
							assertReviewSignoff(
								state.progress.review as RepairReview,
								snapshot,
								checks,
								state.progress.round,
							);
							assertDependencyOutcome(plan, snapshot);
						} catch {
							await change(
								id,
								(value) => {
									value.progress.stage = "blocked";
								},
								"Final code or check proof no longer matches reviewer signoff.",
							);
							return (await get(id)).progress;
						}
						await change(
							id,
							(value) => {
								value.progress.stage = "pushing";
							},
							"Exact-code signoff confirmed; pushing dedicated branch.",
						);
						if (signal.aborted || (await options.isPaused())) return (await get(id)).progress;
						await options.driver.push(workspace, {
							signal,
							head: snapshot.head,
							contentFingerprint: snapshot.contentFingerprint,
							signoff: {
								head: snapshot.head,
								contentFingerprint: snapshot.contentFingerprint,
								validationDigest: checks.validationDigest,
							},
							checks,
						});
						await change(
							id,
							(value) => {
								value.progress.stage = "pushed";
							},
							"Reviewed dependency repair branch pushed; no merge or release performed.",
						);
						return (await get(id)).progress;
					}
					if (!state.workerDone) {
						if (
							state.progress.round === 0 ||
							state.progress.stage === "checking" ||
							state.progress.stage === "reviewing"
						) {
							if (state.progress.round >= state.progress.maxRounds) {
								await change(
									id,
									(value) => {
										value.progress.stage = "exhausted";
									},
									"Maximum 20-or-configured review rounds exhausted; no signoff, no push.",
								);
								return (await get(id)).progress;
							}
							await change(
								id,
								(value) => {
									value.progress.round++;
									value.progress.stage = "fixing";
									value.progress.review = null;
								},
								"Starting dependency fix/review round.",
							);
							state = await get(id);
						}
						if (!state.updatedDependency) {
							try {
								await options.driver.updateDependency(workspace, {
									manifest: plan.manifest,
									section: plan.section,
									name: plan.dependency,
									version: plan.targetVersion,
								});
							} catch {
								await change(
									id,
									(value) => {
										value.progress.stage = "blocked";
									},
									"Dependency installation blocked; sandbox or supported manifest prerequisites missing.",
								);
								return (await get(id)).progress;
							}
							await change(
								id,
								(value) => {
									value.updatedDependency = true;
								},
								"Dependency manifest and lockfile updated with lifecycle scripts disabled.",
							);
						}
						const work = await options.models.work({
							issue,
							plan,
							workspace,
							round: state.progress.round,
							feedback: state.feedback,
							requestId: `${id}:work:${state.progress.round}`,
						});
						await change(
							id,
							(value) => {
								value.workerDone = true;
								value.progress.workerConversationId = work.conversationId;
								value.progress.stage = "checking";
							},
							work.summary,
						);
					}
					state = await get(id);
					let checked: CheckReceipt;
					let snapshot: WorkspaceSnapshot;
					try {
						snapshot = await options.driver.snapshot(workspace);
						assertDependencyOutcome(plan, snapshot);
						checked = await options.driver.check(workspace, {
							contentFingerprint: snapshot.contentFingerprint,
							signal,
						});
						snapshot = await options.driver.commit(workspace, {
							signal,
							contentFingerprint: snapshot.contentFingerprint,
							files: snapshot.changedPaths,
							message: `fix: update ${plan.dependency} for issue ${issue.number}`,
							checks: checked,
						});
						checked = await options.driver.check(workspace, {
							contentFingerprint: snapshot.contentFingerprint,
							signal,
						});
					} catch (error) {
						await change(
							id,
							(value) => {
								value.workerDone = false;
								value.progress.stage = "checking";
								value.feedback =
									`Validation or atomic commit failed. Inspect the permitted files and correct the dependency change; do not weaken checks. ${error instanceof WorkspaceError ? (error.details ?? error.message) : "No safe diagnostics available."}`.slice(
										0,
										3000,
									);
							},
							"Checks failed; changes return to worker, no review approval or push.",
						);
						continue;
					}
					await change(
						id,
						(value) => {
							value.snapshot = snapshot;
							value.checks = checked;
							value.progress.stage = "reviewing";
							value.progress.head = snapshot.head;
							value.progress.contentFingerprint = snapshot.contentFingerprint;
						},
						"Astra reviewer examines the exact committed diff and check evidence.",
					);
					const reviewed = await options.models.review({
						issue,
						plan,
						snapshot,
						checks: checked,
						round: state.progress.round,
						requestId: `${id}:review:${state.progress.round}:${snapshot.contentFingerprint}`,
					});
					const review = repairReviewSchema.parse(reviewed.review);
					if (review.verdict === "signoff")
						assertReviewSignoff(review, snapshot, checked, state.progress.round);
					await change(
						id,
						(value) => {
							value.progress.review = review;
							value.progress.reviewerConversationId = reviewed.conversationId;
							value.progress.stage =
								review.verdict === "signoff"
									? "signed_off"
									: review.verdict === "blocked"
										? "blocked"
										: "reviewing";
							value.workerDone = review.verdict === "signoff";
							value.feedback = JSON.stringify(review);
						},
						review.summary,
					);
				}
				return (await get(id)).progress;
			} finally {
				running = false;
			}
		},
	};
}
