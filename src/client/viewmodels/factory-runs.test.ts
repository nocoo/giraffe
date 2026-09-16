import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { factoryFixture } from "../../../tests/fixtures/factory-snapshot";
import { type FactoryRunResponse, makeRun, runProgress } from "../../lib/factory-run";
import { apiGet, apiPost } from "../lib/api";
import {
	controlFactoryRun,
	createRunPolling,
	loadFactoryRuns,
	runRepositoryRows,
	secondsUntil,
	startFactoryRun,
} from "./factory-runs";
import { setActiveAccountId } from "./session";

vi.mock("../lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const snap = factoryFixture();
const run = makeRun("r", snap.account_id, "nocoo", "key", "refresh", snap.repos, snap.fetched_at);
const state: FactoryRunResponse = {
	account_id: snap.account_id,
	serverNow: snap.fetched_at,
	current: { ...run, leaseUntil: null, progress: runProgress(run, snap.fetched_at) },
	history: [],
	repositories: [],
	catalog: snap.repos,
	catalogUpdatedAt: snap.fetched_at,
	catalogComplete: true,
	nextAllowedAt: null,
	publication: null,
};
beforeEach(() => {
	setActiveAccountId(snap.account_id);
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts" ? { accounts: [{ id: snap.account_id, is_active: true }] } : state,
	);
	vi.mocked(apiPost).mockResolvedValue({ account_id: snap.account_id, id: "r" });
});
afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	setActiveAccountId(null);
});
it("loads server state independently of the snapshot and rejects stale-account responses", async () => {
	expect(await loadFactoryRuns()).toEqual(state);
	await startFactoryRun({ mode: "refresh", scope: "selected", repos: ["nocoo/app"] }, "key");
	expect(apiPost).toHaveBeenCalledWith("factory/runs", {
		account_id: snap.account_id,
		requestKey: "key",
		mode: "refresh",
		scope: "selected",
		repos: ["nocoo/app"],
	});
	await controlFactoryRun("r", "pause");
	expect(apiPost).toHaveBeenLastCalledWith("factory/runs/r/control", {
		account_id: snap.account_id,
		action: "pause",
	});
	vi.mocked(apiPost).mockResolvedValue({ account_id: "other" });
	expect(await controlFactoryRun("r", "resume")).toBeNull();
	vi.mocked(apiGet).mockImplementation(async (path) =>
		path === "accounts"
			? { accounts: [{ id: snap.account_id, is_active: true }] }
			: { ...state, account_id: "other" },
	);
	expect(await loadFactoryRuns()).toBeNull();
});
it("serializes polling, slows hidden/idle pages and backs off errors without clearing data", async () => {
	vi.useFakeTimers();
	const receive = vi.fn(),
		error = vi.fn();
	let hidden = false;
	const load = vi.fn().mockResolvedValue(state);
	const poll = createRunPolling({ load, onData: receive, onError: error, hidden: () => hidden });
	await vi.advanceTimersByTimeAsync(0);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(4999);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(load).toHaveBeenCalledTimes(2);
	hidden = true;
	await poll.refresh();
	await vi.advanceTimersByTimeAsync(59000);
	expect(load).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(1000);
	expect(load).toHaveBeenCalledTimes(4);
	load.mockRejectedValueOnce(new Error("offline"));
	await poll.refresh();
	expect(error).toHaveBeenCalledTimes(1);
	expect(receive).toHaveBeenCalledTimes(4);
	poll.stop();
	await vi.advanceTimersByTimeAsync(120000);
	expect(load).toHaveBeenCalledTimes(5);
});
it("reports only actual step completion and server-clock cooldowns", () => {
	expect(secondsUntil("2026-09-15T22:00:30Z", Date.parse(snap.fetched_at))).toBe(30);
	expect(secondsUntil(null, Date.now())).toBe(0);
	expect(secondsUntil("2000-01-01", Date.now())).toBe(0);
	expect(runRepositoryRows(state.current, state.repositories)[0]).toMatchObject({
		repo: "nocoo/app",
		completed: 0,
		total: 9,
		status: "pending",
	});
	expect(runRepositoryRows(null, [])).toEqual([]);
});

it("coalesces overlapping reads, stops late responses and uses idle/error retry delays", async () => {
	vi.useFakeTimers();
	let resolve: (state: FactoryRunResponse | null) => void = () => {};
	const load = vi.fn(
		() =>
			new Promise<FactoryRunResponse | null>((done) => {
				resolve = done;
			}),
	);
	const receive = vi.fn(),
		error = vi.fn();
	const poll = createRunPolling({ load, onData: receive, onError: error, hidden: () => false });
	const first = poll.refresh();
	expect(poll.refresh()).toBe(first);
	resolve({ ...state, current: null });
	await first;
	await vi.advanceTimersByTimeAsync(29999);
	expect(load).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(load).toHaveBeenCalledTimes(2);
	resolve(null);
	await vi.advanceTimersByTimeAsync(0);
	const late = poll.refresh();
	poll.stop();
	resolve(state);
	await late;
	expect(receive).toHaveBeenCalledTimes(1);
	await poll.refresh();
	expect(load).toHaveBeenCalledTimes(3);
	const failed = vi.fn().mockRejectedValue(new Error("offline"));
	const retry = createRunPolling({
		load: failed,
		onData: receive,
		onError: error,
		hidden: () => false,
	});
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(10000);
	expect(failed).toHaveBeenCalledTimes(2);
	retry.stop();
});
it("derives repository outcome from persisted steps, retaining last success timestamps", () => {
	const view = structuredClone(state.current);
	if (!view) throw new Error("fixture");
	const steps = view.steps.filter((s) => s.repo);
	for (const status of ["running", "failed", "skipped", "success"] as const) {
		for (const step of steps) {
			step.status = status;
			step.pages = 1;
			step.durationMs = 1000;
		}
		const rows = runRepositoryRows(view, [
			{
				repo: "nocoo/app",
				refreshedAt: snap.fetched_at,
				status: "success",
				nextAllowedAt: snap.fetched_at,
			},
		]);
		expect(rows[0]?.status).toBe(status);
		expect(rows[0]?.durationMs).toBe(9000);
		expect(rows[0]?.state?.refreshedAt).toBe(snap.fetched_at);
	}
});
it("does not accept responses after the active account changes", async () => {
	vi.mocked(apiPost).mockImplementationOnce(async () => {
		setActiveAccountId("other");
		return { account_id: snap.account_id };
	});
	expect(await startFactoryRun({ mode: "catalog", scope: "all" }, "key")).toBeNull();
	setActiveAccountId(snap.account_id);
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return { accounts: [{ id: snap.account_id, is_active: true }] };
		setActiveAccountId("other");
		return state;
	});
	expect(await loadFactoryRuns()).toBeNull();
});

it("ignores an error arriving after the view has unmounted", async () => {
	let reject: (error: Error) => void = () => {};
	const onError = vi.fn();
	const poll = createRunPolling({
		load: () =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
		onData: vi.fn(),
		onError,
		hidden: () => false,
	});
	const pending = poll.refresh();
	poll.stop();
	reject(new Error("late failure"));
	await pending;
	expect(onError).not.toHaveBeenCalled();
});
