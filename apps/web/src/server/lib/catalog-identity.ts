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
