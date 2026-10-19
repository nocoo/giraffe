import type { WorkProgress } from "../../../apps/web/src/lib/work-contracts.ts";

export function boundedProgress(progress: WorkProgress): WorkProgress {
	const repositories = Object.fromEntries(
		Object.entries(progress.repositories)
			.slice(0, 25)
			.map(([name, value]) => [
				name,
				{
					...value,
					tasks: value.tasks.slice(0, 100),
					findings: value.findings.slice(0, 8).map((finding) => finding.slice(0, 500)),
					...(value.dispositions
						? {
								dispositions: value.dispositions.slice(0, 100).map((item) => ({
									...item,
									...(item.reason ? { reason: item.reason.slice(0, 500) } : {}),
								})),
							}
						: {}),
				},
			]),
	);
	const value = {
		...progress,
		repositories,
		events: progress.events.slice(-40).map((event) => event.slice(0, 1000)),
	};
	while (new TextEncoder().encode(JSON.stringify(value)).length > 60000) {
		const detailed = Object.values(value.repositories).find((repo) => repo.dispositions?.length);
		if (detailed) {
			detailed.dispositionOutcomes = detailed.tasks
				.map((task) => {
					const outcome = detailed.dispositions?.find((item) => item.task === task)?.outcome;
					return outcome === "committed"
						? "C"
						: outcome === "reviewed_no_change"
							? "N"
							: outcome === "deferred"
								? "D"
								: "-";
				})
				.join("");
			detailed.detailsOmitted = true;
			delete detailed.dispositions;
		} else if (value.events.length) value.events.shift();
		else {
			const verbose = Object.values(value.repositories).find((repo) => repo.tasks.length);
			if (verbose) {
				verbose.compactTasks = verbose.tasks
					.map((task) => task.replace("dependency:", "d").replace("pr:", "p").replace("ci:", "c"))
					.join(",");
				verbose.tasks = [];
				continue;
			}
			const largest = Object.values(value.repositories).sort(
				(left, right) => right.findings.join("").length - left.findings.join("").length,
			)[0];
			if (!largest?.findings.length) throw new Error("Work summary exceeds payload budget.");
			largest.findings.pop();
		}
	}
	return value;
}
