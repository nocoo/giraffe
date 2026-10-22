export type SourceMetric = "auth" | "build" | "decode" | "hash" | "serialize" | "total";
export type SourceWork = "decoded_rows" | "decoded_bytes" | "hash_ops" | "serialized_bytes";

export class SourceTiming {
	private readonly durations = new Map<string, number>(
		["auth", "build", "decode", "hash", "serialize", "total"].map((name) => [name, 0]),
	);
	private trips = 0;
	private queries = 0;
	private readonly active = new Map<SourceMetric, { count: number; startedAt: number }>();
	private readonly counts = new Map<SourceWork, number>();
	private readonly startedAt = performance.now();

	private add(name: string, duration: number) {
		if (Number.isFinite(duration) && duration >= 0)
			this.durations.set(name, (this.durations.get(name) ?? 0) + duration);
	}

	work(name: SourceWork, amount: number) {
		const total = (this.counts.get(name) ?? 0) + amount;
		if (Number.isSafeInteger(amount) && amount >= 0 && Number.isSafeInteger(total))
			this.counts.set(name, total);
	}

	private begin(name: SourceMetric) {
		const active = this.active.get(name);
		if (active) active.count += 1;
		else this.active.set(name, { count: 1, startedAt: performance.now() });
		if (name === "hash") this.work("hash_ops", 1);
	}

	private end(name: SourceMetric) {
		const active = this.active.get(name);
		if (!active) return;
		active.count -= 1;
		if (active.count === 0) {
			this.add(name, performance.now() - active.startedAt);
			this.active.delete(name);
		}
	}

	stringify(value: unknown): string {
		return this.measure("serialize", () => {
			const body = JSON.stringify(value);
			this.work("serialized_bytes", new TextEncoder().encode(body).byteLength);
			return body;
		});
	}

	measure<Result>(name: SourceMetric, operation: () => Result): Result {
		this.begin(name);
		try {
			return operation();
		} finally {
			this.end(name);
		}
	}

	async measureAsync<Result>(
		name: SourceMetric,
		operation: () => Promise<Result>,
	): Promise<Result> {
		this.begin(name);
		try {
			return await operation();
		} finally {
			this.end(name);
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
		return [
			...[...this.durations].map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`),
			...[...this.counts].map(([name, count]) => `${name};desc="${count}"`),
		].join(", ");
	}
}
