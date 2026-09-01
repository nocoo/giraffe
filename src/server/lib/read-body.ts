import { ApiError } from "./errors";

export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
	const type = request.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) {
		throw new ApiError(400, "validation_failed", "json required");
	}
	const reader = request.body?.getReader();
	if (!reader) {
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
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new ApiError(400, "validation_failed", "invalid json");
	}
}
