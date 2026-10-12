export const APP_PATHS = [
	"/",
	"/factory",
	"/repos",
	"/analysis",
	"/work",
	"/refresh",
	"/issues",
	"/pulls",
	"/insights",
	"/ci",
	"/alerts",
	"/inbox",
	"/repos/:owner/:name",
	"/settings",
	"/authorize",
] as const;

export type AppPath = (typeof APP_PATHS)[number];
