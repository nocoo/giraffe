import { walk } from "./fetch-ast";

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
	if (node?.type === "Identifier") {
		return identName(node);
	}
	return undefined;
}

export function evalConstString(node: Record<string, unknown> | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	if (node.type === "TemplateLiteral") {
		const quasis = node.quasis as Array<Record<string, unknown>> | undefined;
		const exprs = node.expressions as unknown[] | undefined;
		if (quasis?.length === 1 && (!exprs || exprs.length === 0)) {
			const cooked = rec(quasis[0]?.value)?.cooked;
			if (typeof cooked === "string") {
				return cooked;
			}
		}
	}
	if (node.type === "BinaryExpression" && node.operator === "+") {
		const left = evalConstString(rec(node.left));
		const right = evalConstString(rec(node.right));
		if (left !== undefined && right !== undefined) {
			return `${left}${right}`;
		}
	}
	return undefined;
}

export function isApiPath(value: string): boolean {
	return value === "/api" || value.startsWith("/api/");
}

const MOUNT_METHODS = new Set([
	"route",
	"basePath",
	"mount",
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"all",
	"use",
]);

export function localApiAliases(root: unknown): Set<string> {
	const aliases = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		walk(root, (node) => {
			if (node.type !== "VariableDeclarator") {
				return;
			}
			const name = identName(rec(node.id));
			const value = evalConstString(rec(node.init));
			if (name && value && isApiPath(value) && !aliases.has(name)) {
				aliases.add(name);
				changed = true;
			}
		});
	}
	return aliases;
}

export function exportedApiBindings(root: unknown): Map<string, string> {
	const found = new Map<string, string>();
	walk(root, (node) => {
		if (node.type === "ExportNamedDeclaration") {
			const decl = rec(node.declaration);
			if (decl?.type === "VariableDeclaration" && Array.isArray(decl.declarations)) {
				for (const d of decl.declarations) {
					const n = rec(d);
					const name = identName(rec(n?.id));
					const value = evalConstString(rec(n?.init));
					if (name && value && isApiPath(value)) {
						found.set(name, value);
					}
				}
			}
		}
	});
	return found;
}

export function importSpecs(
	root: unknown,
): Array<{ local: string; imported: string; from: string }> {
	const specs: Array<{ local: string; imported: string; from: string }> = [];
	walk(root, (node) => {
		if (node.type !== "ImportDeclaration") {
			return;
		}
		const from = evalConstString(rec(node.source));
		if (!from?.startsWith(".")) {
			return;
		}
		const specifiers = node.specifiers as unknown[] | undefined;
		if (!specifiers) {
			return;
		}
		for (const spec of specifiers) {
			const s = rec(spec);
			if (s?.type === "ImportSpecifier") {
				const imported = identName(rec(s.imported)) ?? identName(rec(s.local));
				const local = identName(rec(s.local));
				if (imported && local) {
					specs.push({ local, imported, from });
				}
			}
		}
	});
	return specs;
}

export function sourceHasApiRoutes(root: unknown, extraAliases: Set<string> = new Set()): boolean {
	const aliases = new Set([...localApiAliases(root), ...extraAliases]);
	let hit = false;
	walk(root, (node) => {
		if (hit) {
			return;
		}
		const literal = evalConstString(node);
		if (literal && isApiPath(literal)) {
			hit = true;
			return;
		}
		if (node.type !== "CallExpression") {
			return;
		}
		const callee = rec(node.callee);
		if (callee?.type !== "MemberExpression") {
			return;
		}
		const method = propertyName(rec(callee.property));
		if (!method || !MOUNT_METHODS.has(method)) {
			return;
		}
		const args = node.arguments as unknown[] | undefined;
		const first = rec(args?.[0]);
		const firstStr = evalConstString(first);
		const firstName = identName(first);
		if ((firstStr && isApiPath(firstStr)) || (firstName && aliases.has(firstName))) {
			hit = true;
		}
	});
	return hit;
}
