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

function stringLiteral(node: Record<string, unknown> | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") {
		return node.value;
	}
	if (node?.type === "TemplateLiteral") {
		const quasis = node.quasis as Array<Record<string, unknown>> | undefined;
		if (quasis?.length === 1) {
			const cooked = rec(quasis[0]?.value)?.cooked;
			if (typeof cooked === "string") {
				return cooked;
			}
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

export function sourceHasApiRoutes(root: unknown): boolean {
	const aliases = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		walk(root, (node) => {
			if (node.type !== "VariableDeclarator") {
				return;
			}
			const name = identName(rec(node.id));
			const value = stringLiteral(rec(node.init));
			if (name && value && isApiPath(value) && !aliases.has(name)) {
				aliases.add(name);
				changed = true;
			}
		});
	}

	let hit = false;
	walk(root, (node) => {
		if (hit) {
			return;
		}
		const literal = stringLiteral(node);
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
		const firstStr = stringLiteral(first);
		const firstName = identName(first);
		if ((firstStr && isApiPath(firstStr)) || (firstName && aliases.has(firstName))) {
			hit = true;
		}
	});
	return hit;
}
