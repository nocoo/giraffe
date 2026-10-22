import { ApiError } from "./errors";

function requireJson(request: Request) {
	const rawType = request.headers.get("content-type") ?? "";
	const [type, ...params] = rawType.split(";").map((part) => part.trim().toLowerCase());
	if (type !== "application/json") {
		throw new ApiError(400, "validation_failed", "json required");
	}
	if (params.some((part) => part.startsWith("charset=") && part !== "charset=utf-8")) {
		throw new ApiError(400, "validation_failed", "json required");
	}
}

export async function readJson(
	request: Request,
	maxBytes: number,
	optional = false,
): Promise<unknown> {
	if (!optional) requireJson(request);
	const reader = request.body?.getReader();
	if (!reader) {
		if (optional) return undefined;
		throw new ApiError(400, "validation_failed", "empty body");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new ApiError(400, "validation_failed", "body too large");
			}
			chunks.push(value);
		}
	}
	if (optional && total === 0) return undefined;
	if (optional) requireJson(request);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
		) as unknown;
	} catch {
		throw new ApiError(400, "validation_failed", "invalid json");
	}
}
