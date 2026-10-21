import { ApiError } from "./errors";

export function assertMachineQuery(query: Record<string, string>, allowed: readonly string[] = []) {
	if (Object.keys(query).some((key) => !allowed.includes(key)))
		throw new ApiError(400, "validation_failed", "unknown query parameter");
}
