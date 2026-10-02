import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function acquireInstance(directory: string, name = "agent") {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const database = new DatabaseSync(join(directory, `${name}.lock.sqlite`));
	try {
		database.exec("BEGIN IMMEDIATE");
	} catch {
		database.close();
		throw new Error(
			"Another Giraffe process owns this account. Stop it before starting a second one.",
		);
	}
	return () => database.close();
}
