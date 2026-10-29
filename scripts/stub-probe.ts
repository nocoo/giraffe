import { get } from "node:http";

const TIMEOUT_MS = 5_000;

export function probeText(port: number, path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const request = get(
			{ hostname: "127.0.0.1", port, path, agent: false, timeout: TIMEOUT_MS },
			(res) => {
				if (res.statusCode !== 200) {
					res.on("error", reject);
					res.resume();
					reject(new Error(`probe ${path} returned ${res.statusCode}`));
					return;
				}
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("aborted", () => reject(new Error(`probe ${path} aborted`)));
				res.on("error", reject);
				res.on("end", () => resolve(body));
			},
		);
		request.on("timeout", () => {
			request.destroy();
			reject(new Error(`probe ${path} timed out after ${TIMEOUT_MS}ms`));
		});
		request.on("error", reject);
	});
}
