export const githubUnavailableFixtures = [
	{
		status: 403,
		message: "Dependabot alerts are disabled for this repository.",
		code: "alerts_disabled",
	},
	{
		status: 404,
		message: "Dependabot alerts are not enabled for this repository.",
		code: "alerts_disabled",
	},
	{ status: 403, message: "Resource not accessible by integration", code: "permission_denied" },
	{
		status: 403,
		message: "Resource not accessible by personal access token",
		code: "permission_denied",
	},
	{ status: 403, message: "Insufficient scope", code: "permission_denied" },
	{ status: 404, message: "Not Found", code: "not_found" },
	{ status: 403, message: "Unrecognized private upstream diagnostics", code: "unknown" },
] as const;
