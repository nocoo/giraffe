import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { logFactory } from "./factory-log";

const output = vi.fn();
const secret = `ghp_${"x".repeat(36)}`;
const payload = JSON.stringify({ private: "upstream account data", authorization: secret });
const generic = { name: "Error", code: "internal_error", message: "factory operation failed" };

beforeEach(() => {
	output.mockReset();
	vi.spyOn(console, "log").mockImplementation(output);
});
afterEach(() => vi.restoreAllMocks());

function logged() {
	expect(output).toHaveBeenCalledOnce();
	expect(output.mock.calls[0]).toHaveLength(1);
	const line: unknown = output.mock.calls[0]?.[0];
	expect(typeof line).toBe("string");
	if (typeof line !== "string") throw new Error("missing log line");
	expect(line).not.toContain("\n");
	expect(line).not.toContain(secret);
	expect(line).not.toContain("upstream account data");
	return JSON.parse(line);
}

it("writes one structured JSON line with caller context and no absent error", () => {
	logFactory("factory_invocation", {
		runId: "run_123",
		cursorStart: 2,
		cursorEnd: 5,
		stepsDone: 3,
		requests: 4,
		statements: 12,
		stagedWrites: 0,
		elapsedMs: 123,
		endReason: "completed",
	});
	expect(logged()).toEqual({
		event: "factory_invocation",
		runId: "run_123",
		cursorStart: 2,
		cursorEnd: 5,
		stepsDone: 3,
		requests: 4,
		statements: 12,
		stagedWrites: 0,
		elapsedMs: 123,
		endReason: "completed",
	});
});

it.each([
	["db_error", "d1 operation failed"],
	["factory_lease_lost", "factory lease lost"],
	["factory_yield", "factory invocation yielded"],
	["queue_overloaded", "queue send overloaded"],
	["github_error", "github operation failed"],
	["github_rate_limited", "github rate limited"],
	["github_forbidden", "github access forbidden"],
	["github_unauthorized", "github authorization failed"],
	["github_response_too_large", "github response too large"],
	["factory_capacity", "factory capacity exceeded"],
	["checkpoint_invalid", "factory checkpoint invalid"],
	["worker_interrupted", "factory worker interrupted"],
	["snapshot_missing", "factory snapshot missing"],
	["snapshot_incomplete", "factory snapshot incomplete"],
	["snapshot_unavailable", "factory snapshot unavailable"],
	["snapshot_sources_incomplete", "factory snapshot sources incomplete"],
	["catalog_changed", "factory catalog changed"],
	["catalog_incomplete", "factory catalog incomplete"],
	["account_missing", "factory account missing"],
	["account_conflict", "factory account conflict"],
	["repository_unavailable", "factory repository unavailable"],
	["repository_cooldown", "factory repository cooling down"],
	["refresh_cooldown", "factory refresh cooling down"],
	["schedule_deferred", "factory schedule deferred"],
	["validation_failed", "factory validation failed"],
	["not_found", "factory resource not found"],
	["encryption_key_missing", "factory encryption key missing"],
	["internal_error", "factory operation failed"],
])("preserves the known ApiError classification %s without its payload", (code, message) => {
	const error = new ApiError(500, code, payload);
	Object.assign(error, { name: secret, stack: payload, cause: { payload }, payload });
	logFactory("factory_consume_error", { runId: "run_123" }, error);
	expect(logged()).toEqual({
		event: "factory_consume_error",
		runId: "run_123",
		error: { name: "ApiError", code, message },
	});
});

it.each([
	secret,
	payload,
	"user_supplied_unknown_code",
	"db_error\nprivate payload",
	"db_error_private_payload",
	"__proto__",
	"constructor",
	"toString",
])("rejects malicious or unknown ApiError codes without copying them", (code) => {
	logFactory("factory_consume_error", {}, new ApiError(500, code, payload));
	expect(logged().error).toEqual({ ...generic, name: "ApiError" });
});

it("omits an optional undefined failure on successful invocations", () => {
	logFactory("factory_invocation", { endReason: "completed" }, undefined);
	expect(logged()).toEqual({ event: "factory_invocation", endReason: "completed" });
});

it.each([null, false, true, 429, 10250, 42n, Symbol("private"), secret, payload])(
	"normalizes arbitrary thrown primitives without serializing them",
	(error) => {
		logFactory("factory_consume_error", { runId: "run_123" }, error);
		expect(logged().error).toEqual(generic);
	},
);

it.each([
	new Error(payload),
	new TypeError(payload),
	{ message: payload, name: secret, stack: secret, cause: secret, code: secret },
	[secret, payload],
	() => secret,
])("discards raw names, messages, stacks, causes and payloads", (error) => {
	logFactory("factory_consume_error", {}, error);
	expect(logged().error).toEqual({
		...generic,
		name: error instanceof TypeError ? "TypeError" : "Error",
	});
});

it.each([
	new Error(`Queue is overloaded. Please back off. (10250) ${payload}`),
	new Error(`Queue send failed (429) ${payload}`),
	`Queue send failed (10250) ${payload}`,
	{ code: 10250, message: payload },
	{ code: "10250", message: payload },
	{ status: 429, message: payload },
	{ status: "429", message: payload },
	{ statusCode: 429, message: payload },
	{ statusCode: "429", message: payload },
])("normalizes Queue overload into a fixed safe classification", (error) => {
	logFactory("factory_queue_send_error", { attempt: 1, retryDelayMs: 500 }, error);
	expect(logged().error).toEqual({
		name: "Error",
		code: "queue_overloaded",
		message: "queue send overloaded",
	});
});

it.each(["1429", "102500"])("does not mistake unrelated numeric text %s for overload", (code) => {
	logFactory("factory_queue_send_error", {}, new Error(`queue error ${code}`));
	expect(logged().error).toEqual(generic);
});

it("keeps a known GitHub rate limit distinct from Queue overload", () => {
	logFactory("factory_consume_error", {}, new ApiError(429, "github_rate_limited", payload));
	expect(logged().error).toEqual({
		name: "ApiError",
		code: "github_rate_limited",
		message: "github rate limited",
	});
});

it("does not invoke accessors or serializers supplied on a thrown error", () => {
	const access = vi.fn(() => {
		throw new Error(payload);
	});
	const error = Object.defineProperties(new ApiError(500, "db_error", payload), {
		code: { get: access },
		status: { get: access },
		statusCode: { get: access },
		message: { get: access },
		toJSON: { value: access },
	});
	logFactory("factory_consume_error", {}, error);
	expect(logged().error).toEqual({ ...generic, name: "ApiError" });
	expect(access).not.toHaveBeenCalled();
});

it("logs a safe fallback for uninspectable thrown objects", () => {
	const proxy = Proxy.revocable({}, {});
	proxy.revoke();
	logFactory("factory_consume_error", {}, proxy.proxy);
	expect(logged().error).toEqual(generic);
});

it("does not traverse cyclic payloads or serialize custom errors", () => {
	const serialize = vi.fn(() => payload);
	const error: Record<string, unknown> = { message: payload, toJSON: serialize };
	error.cause = error;
	logFactory("factory_consume_error", {}, error);
	expect(logged().error).toEqual(generic);
	expect(serialize).not.toHaveBeenCalled();
});

it("reserves event and error fields instead of forwarding caller-supplied error data", () => {
	logFactory("factory_invocation", { event: "injected", error: payload, runId: "run_123" });
	expect(logged()).toEqual({ event: "factory_invocation", runId: "run_123" });
});
