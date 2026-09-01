export type Identity = {
	email: string;
	name: string;
};

export function identityFromClaims(email: unknown, name: unknown): Identity {
	if (typeof email !== "string" || email.length === 0) {
		throw new Error("missing email");
	}
	const resolvedName = typeof name === "string" && name.length > 0 ? name : email;
	return { email, name: resolvedName };
}
