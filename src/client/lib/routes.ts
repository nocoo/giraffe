export const APP_PATHS = [
	"/",
	"/issues",
	"/pulls",
	"/insights",
	"/alerts",
	"/inbox",
	"/digest",
	"/repos/:owner/:name",
	"/settings",
] as const;

export type AppPath = (typeof APP_PATHS)[number];
