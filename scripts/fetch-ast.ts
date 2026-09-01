export function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
	if (!node || typeof node !== "object") {
		return;
	}
	const rec = node as Record<string, unknown>;
	visit(rec);
	for (const value of Object.values(rec)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				walk(item, visit);
			}
		} else {
			walk(value, visit);
		}
	}
}

function isFetchExpr(node: Record<string, unknown> | undefined): boolean {
	if (!node) {
		return false;
	}
	if (node.type === "Identifier" && node.name === "fetch") {
		return true;
	}
	if (node.type === "MemberExpression") {
		const obj = node.object as Record<string, unknown> | undefined;
		const prop = node.property as Record<string, unknown> | undefined;
		return prop?.name === "fetch" && (obj?.name === "self" || obj?.name === "globalThis");
	}
	return false;
}

export function collectFetchAliases(root: unknown): Set<string> {
	const aliases = new Set(["fetch"]);
	let changed = true;
	while (changed) {
		changed = false;
		walk(root, (node) => {
			if (node.type !== "VariableDeclarator") {
				return;
			}
			const id = node.id as Record<string, unknown> | undefined;
			const init = node.init as Record<string, unknown> | undefined;
			if (id?.type === "Identifier" && init) {
				const name = String(id.name);
				if (isFetchExpr(init) || (init.type === "Identifier" && aliases.has(String(init.name)))) {
					if (!aliases.has(name)) {
						aliases.add(name);
						changed = true;
					}
				}
			}
			if (id?.type === "ObjectPattern" && Array.isArray(id.properties)) {
				for (const prop of id.properties) {
					const p = prop as Record<string, unknown>;
					const key = p.key as Record<string, unknown> | undefined;
					const value = p.value as Record<string, unknown> | undefined;
					if (key?.name === "fetch" && value?.type === "Identifier") {
						const name = String(value.name);
						if (!aliases.has(name)) {
							aliases.add(name);
							changed = true;
						}
					}
				}
			}
		});
	}
	return aliases;
}

export function isFetchCall(node: Record<string, unknown>, aliases: Set<string>): boolean {
	if (node.type !== "CallExpression") {
		return false;
	}
	const callee = node.callee as Record<string, unknown> | undefined;
	if (!callee) {
		return false;
	}
	if (callee.type === "Identifier" && typeof callee.name === "string" && aliases.has(callee.name)) {
		return true;
	}
	return isFetchExpr(callee);
}
