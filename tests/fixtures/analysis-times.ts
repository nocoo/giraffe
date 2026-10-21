export const analysisTimeCases = [
	{
		name: "sub-millisecond precision",
		entries: [
			["z", "2026-10-02T08:00:00.000100Z"],
			["y", "2026-10-02T08:00:00.000200Z"],
			["x", "2026-10-02T08:00:00.000300Z"],
			["a", "2026-10-02T08:00:00.000400Z"],
		],
		expected: ["a", "x", "y"],
	},
	{
		name: "equivalent offsets and trailing-zero ties",
		entries: [
			["a", "2026-10-02T00:00:00.000100-08:00"],
			["x", "2026-10-02T16:00:00.00010+08:00"],
			["y", "2026-10-02T08:00:00.000100000+00:00"],
			["z", "2026-10-02T08:00:00.0001Z"],
		],
		expected: ["z", "y", "x"],
	},
	{
		name: "whole seconds without fractional rounding carry",
		entries: [
			["z", "2026-10-02T08:00:00.9999Z"],
			["y", "2026-10-02T08:00:00.9997Z"],
			["x", "2026-10-02T08:00:00.9998Z"],
			["a", "2026-10-02T08:00:01Z"],
		],
		expected: ["a", "z", "x"],
	},
	{
		name: "arbitrary fractional precision",
		entries: [
			["z", "2026-10-02T08:00:00.000000000000000000000000000001Z"],
			["y", "2026-10-02T08:00:00.000000000000000000000000000002Z"],
			["x", "2026-10-02T08:00:00.000000000000000000000000000003Z"],
			["a", "2026-10-02T08:00:00.000000000000000000000000000004Z"],
		],
		expected: ["a", "x", "y"],
	},
	{
		name: "all-zero fractions and the full Zod offset range",
		entries: [
			["a", "2026-10-03T07:59:00.000+23:59"],
			["x", "2026-10-01T08:01:00.00000-23:59"],
			["y", "2026-10-02T08:00:00+00:00"],
			["z", "2026-10-02T08:00:00Z"],
		],
		expected: ["z", "y", "x"],
	},
	{
		name: "fraction prefixes compare numerically without numeric conversion",
		entries: [
			["z", "2026-10-02T08:00:00.1Z"],
			["y", "2026-10-02T08:00:00.09999Z"],
			["x", "2026-10-02T08:00:00.10001000Z"],
			["a", "2026-10-02T08:00:00.10001Z"],
		],
		expected: ["x", "a", "z"],
	},
] as const;
