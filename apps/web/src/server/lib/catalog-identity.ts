const identities = new WeakMap<object, string>();

export function identifyCatalogRow<Row extends object>(
	row: Row,
	identity: string | undefined,
): Row {
	if (identity !== undefined) identities.set(row, identity);
	return row;
}

export function catalogRowIdentity(row: object): string | undefined {
	return identities.get(row);
}

export function catalogRowIdentityFromRecord(repo: Record<string, unknown>): string | undefined {
	const identity = catalogRowIdentity(repo);
	if (identity !== undefined) return identity;
	return typeof repo.id === "string" ? repo.id : undefined;
}
