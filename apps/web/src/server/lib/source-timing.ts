export type SourceMetric = "auth" | "build" | "decode" | "hash" | "serialize" | "total";

export class SourceTiming {
	private readonly durations = new Map<string, number>(
		["auth", "build", "decode", "hash", "serialize", "total"].map((name) => [name, 0]),
	);
	private trips = 0;
	private queries = 0;
	private readonly startedAt = performance.now();

	private add(name: string, duration: number) {
		if (Number.isFinite(duration) && duration >= 0)
			this.durations.set(name, (this.durations.get(name) ?? 0) + duration);
	}

	measure<Result>(name: SourceMetric, operation: () => Result): Result {
		const start = performance.now();
		try {
			return operation();
		} finally {
			this.add(name, performance.now() - start);
		}
	}

	async measureAsync<Result>(
		name: SourceMetric,
		operation: () => Promise<Result>,
	): Promise<Result> {
		const start = performance.now();
		try {
			return await operation();
		} finally {
			this.add(name, performance.now() - start);
		}
	}

	recordD1(duration: number, queryDurations: readonly (number | null)[]) {
		this.add(`d1_${++this.trips}`, duration);
		for (const queryDuration of queryDurations) {
			this.queries += 1;
			if (queryDuration !== null) this.add(`sql_${this.queries}`, queryDuration);
		}
	}

	header() {
		this.durations.set("total", Math.max(0, performance.now() - this.startedAt));
		return [...this.durations]
			.map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`)
			.join(", ");
	}
}
