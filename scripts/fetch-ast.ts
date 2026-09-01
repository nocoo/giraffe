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

function rec(node: unknown): Record<string, unknown> | undefined {
	if (!node || typeof node !== "object") {
		return undefined;
	}
	return node as Record<string, unknown>;
}

function identName(node: Record<string, unknown> | undefined): string | undefined {
	if (node?.type === "Identifier" && typeof node.name === "string") {
		return node.name;
	}
	return undefined;
}

function propertyName(node: Record<string, unknown> | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "Identifier") {
		return identName(node);
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	return undefined;
}

const FETCH_ROOTS = new Set(["fetch", "self", "globalThis", "window", "global"]);

export function isFetchExpr(node: Record<string, unknown> | undefined): boolean {
	if (!node) {
		return false;
	}
	if (identName(node) === "fetch") {
		return true;
	}
	if (node.type === "MemberExpression") {
		const obj = rec(node.object);
		const prop = propertyName(rec(node.property));
		const objName = identName(obj);
		if (prop === "fetch" && objName && FETCH_ROOTS.has(objName)) {
			return true;
		}
	}
	if (node.type === "CallExpression") {
		const callee = rec(node.callee);
		if (callee?.type === "MemberExpression") {
			const method = propertyName(rec(callee.property));
			if (method === "bind" || method === "call" || method === "apply") {
				return isFetchExpr(rec(callee.object));
			}
		}
	}
	return false;
}

function addAlias(aliases: Set<string>, name: string): boolean {
	if (aliases.has(name)) {
		return false;
	}
	aliases.add(name);
	return true;
}

function exprIsFetchLike(node: Record<string, unknown> | undefined, aliases: Set<string>): boolean {
	if (!node) {
		return false;
	}
	if (isFetchExpr(node)) {
		return true;
	}
	const name = identName(node);
	return name !== undefined && aliases.has(name);
}

export function collectFetchAliases(root: unknown): Set<string> {
	const aliases = new Set(["fetch"]);
	let changed = true;
	while (changed) {
		changed = false;
		walk(root, (node) => {
			if (node.type === "AssignmentExpression") {
				const left = rec(node.left);
				const right = rec(node.right);
				const name = identName(left);
				if (name && exprIsFetchLike(right, aliases) && addAlias(aliases, name)) {
					changed = true;
				}
				return;
			}
			if (node.type !== "VariableDeclarator") {
				return;
			}
			const id = rec(node.id);
			const init = rec(node.init);
			if (
				identName(id) &&
				exprIsFetchLike(init, aliases) &&
				addAlias(aliases, identName(id) ?? "")
			) {
				changed = true;
			}
			if (id?.type === "ObjectPattern" && Array.isArray(id.properties)) {
				for (const prop of id.properties) {
					const p = rec(prop);
					const key = rec(p?.key);
					const value = rec(p?.value);
					const valueName = identName(value);
					if (propertyName(key) === "fetch" && valueName && addAlias(aliases, valueName)) {
						changed = true;
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
	const callee = rec(node.callee);
	if (!callee) {
		return false;
	}
	if (exprIsFetchLike(callee, aliases)) {
		return true;
	}
	const name = identName(callee);
	return name !== undefined && aliases.has(name);
}
