import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { probeText } from "./stub-probe";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("node:http", () => ({ get }));

class FakeRequest extends EventEmitter {
	destroy = vi.fn();
}

class FakeResponse extends EventEmitter {
	statusCode: number | undefined = 200;
	setEncoding = vi.fn();
	resume = vi.fn();
}

const optionsSeen: Array<Record<string, unknown>> = [];
let request: FakeRequest;
let response: FakeResponse;

beforeEach(() => {
	optionsSeen.length = 0;
	request = new FakeRequest();
	response = new FakeResponse();
	get.mockImplementation(
		(options: Record<string, unknown>, onResponse: (res: FakeResponse) => void) => {
			optionsSeen.push(options);
			onResponse(response);
			return request;
		},
	);
});

it("probes the stub over a one-shot request with a bounded timeout", async () => {
	const result = probeText(17046, "/_count");
	response.emit("data", "7");
	response.emit("end");
	await expect(result).resolves.toBe("7");
	expect(optionsSeen).toEqual([
		{ hostname: "127.0.0.1", port: 17046, path: "/_count", agent: false, timeout: 5_000 },
	]);
});

it("rejects non-200 probe responses instead of returning error bodies", async () => {
	response.statusCode = 500;
	const result = probeText(17046, "/_count");
	response.emit("data", "<html>upstream error</html>");
	response.emit("end");
	await expect(result).rejects.toThrow("probe /_count returned 500");
	expect(response.resume).toHaveBeenCalled();
});

it("rejects when the probe response is aborted mid-stream", async () => {
	const result = probeText(17046, "/_count");
	response.emit("data", "partial");
	response.emit("aborted");
	await expect(result).rejects.toThrow("probe /_count aborted");
});

it("destroys a stalled probe request after the bounded timeout", async () => {
	const result = probeText(17046, "/_count");
	request.emit("timeout");
	await expect(result).rejects.toThrow("probe /_count timed out after 5000ms");
	expect(request.destroy).toHaveBeenCalledOnce();
});

it("rejects on a probe connection error", async () => {
	const result = probeText(17046, "/_count");
	request.emit("error", new Error("ECONNRESET"));
	await expect(result).rejects.toThrow("ECONNRESET");
});
