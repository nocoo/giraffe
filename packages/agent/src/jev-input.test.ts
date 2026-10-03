import { expect, it } from "vitest";
import { boundedBatches, clipText, JEV_MAX_REQUEST_BYTES, requestBytes } from "./jev-input.ts";

it("measures the serialized model-inclusive UTF8 body at the exact boundary", () => {
	const build = (state: string[]) => ({ model: "jev", state, questions: {} });
	const overhead = requestBytes(build([""]));
	const exact = "x".repeat(JEV_MAX_REQUEST_BYTES - overhead);
	expect(requestBytes(build([exact]))).toBe(JEV_MAX_REQUEST_BYTES);
	expect(boundedBatches([exact], build, "test", (item) => String(item.length))).toEqual([[exact]]);
	expect(() => boundedBatches(["small", `${exact}x`], build, "test", () => "owner/repo")).toThrow(
		/owner\/repo.*16385.*16384/,
	);
});

it("packs an exact escaped Unicode body without modifying inputs", () => {
	const build = (state: string[]) => ({ model: 'jev"\\\n😀', state, questions: {} });
	const prefix = '😀"\\\n'.repeat(100);
	const exact = prefix + "x".repeat(JEV_MAX_REQUEST_BYTES - requestBytes(build([prefix])));
	const inputs = [exact];
	const before = structuredClone(inputs);
	expect(requestBytes(build(inputs))).toBe(JEV_MAX_REQUEST_BYTES);
	expect(boundedBatches(inputs, build, "test", () => "owner/repo")).toEqual([inputs]);
	expect(() => boundedBatches([`${exact}x`], build, "test", () => "owner/repo")).toThrow(
		/16385.*16384/,
	);
	expect(inputs).toEqual(before);
});

it("clips by codepoint with explicit omitted counts and sizes escaped Unicode", () => {
	expect(clipText("short", 180)).toBe("short");
	const clipped = clipText("😀".repeat(200), 180);
	expect(clipped).toContain("[clipped 20 codepoints]");
	expect(clipped.startsWith("😀".repeat(180))).toBe(true);
	expect(requestBytes({ text: '😀"\\\n' })).toBe(
		Buffer.byteLength(JSON.stringify({ text: '😀"\\\n' })),
	);
});

it("greedily packs by bytes and count without losing or reordering items", () => {
	const build = (state: string[]) => ({ model: "jev", state, questions: {} });
	const items = Array.from({ length: 26 }, (_, index) => String(index));
	expect(boundedBatches(items, build, "test", String).map((batch) => batch.length)).toEqual([
		25, 1,
	]);
	const large = ["😀".repeat(2100), "😀".repeat(2100), "small"];
	const batches = boundedBatches(large, build, "test", () => "owner/repo");
	expect(batches.flat()).toEqual(large);
	expect(batches.map((batch) => batch.length)).toEqual([1, 2]);
	expect(boundedBatches([], build, "test", String)).toEqual([]);
});
