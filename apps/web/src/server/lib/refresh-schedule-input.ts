import { z } from "zod";
import { MAX_SCHEDULE_TIMES } from "../../lib/refresh-schedule";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const scheduleConfigInput = z
	.object({
		enabled: z.boolean(),
		time: time.optional(),
		times: z.array(time).min(1).max(MAX_SCHEDULE_TIMES).optional(),
		weekday: z.number().int().min(0).max(6),
		scope: z.enum(["all", "starred"]),
	})
	.strict()
	.refine((config) => config.time !== undefined || config.times !== undefined)
	.refine(
		(config) =>
			config.time === undefined ||
			config.times === undefined ||
			config.time === [...config.times].sort()[0],
	);

export function normalizeScheduleConfig<T extends z.infer<typeof scheduleConfigInput>>(config: T) {
	const times = [...new Set(config.times ?? [config.time as string])].sort();
	return { ...config, time: times[0] as string, times };
}
