export const APP_PATHS = [
	"/",
	"/factory",
	"/issues",
	"/pulls",
	"/insights",
	"/ci",
	"/alerts",
	"/inbox",
	"/repos/:owner/:name",
	"/settings",
] as const;

export type AppPath = (typeof APP_PATHS)[number];
