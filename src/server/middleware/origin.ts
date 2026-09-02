import { type EnvMode, envMode } from "../env";
import { ApiError } from "../lib/errors";

export function allowedOrigin(mode: EnvMode): string {
	if (mode === "production") {
		return "https://giraffe.hexly.ai";
	}
	return "https://giraffe.dev.hexly.ai";
}

export function assertOrigin(request: Request, mode: EnvMode, bypass = false): void {
	if (request.method === "GET" || request.method === "HEAD") {
		return;
	}
	if (request.method !== "POST" && request.method !== "DELETE") {
		return;
	}
	const origin = request.headers.get("Origin");
	if (!origin) {
		throw new ApiError(403, "origin_forbidden", "origin not allowed");
	}
	if (origin === allowedOrigin(mode)) {
		return;
	}
	if (bypass && mode === "development" && origin === new URL(request.url).origin) {
		return;
	}
	throw new ApiError(403, "origin_forbidden", "origin not allowed");
}

export function originFromEnv(environment: string | undefined): string {
	return allowedOrigin(envMode(environment));
}
