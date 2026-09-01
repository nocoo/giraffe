export type Identity = {
	email: string;
	name: string;
};

export function identityFromClaims(email: string | undefined, name: string | undefined): Identity {
	if (!email) {
		throw new Error("missing email");
	}
	return { email, name: name && name.length > 0 ? name : email };
}
