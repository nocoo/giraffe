import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../../tests/fixtures/factory-snapshot";
import { savedObservationStmts } from "../../../../../../tests/fixtures/refresh";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { createDb } from "./d1";
import { publishedFactory } from "./factory-runs";

it("reads the current refresh publication independently of retired factory heads", async () => {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('a','owner','fake','fake','t','t')",
		)
		.run();
	expect(await publishedFactory(db, "a")).toBeNull();
	const snapshot = factoryFixture();
	await db.batch(await savedObservationStmts(db, "a", "factory", snapshot, snapshot.fetched_at));
	expect(await publishedFactory(db, "a")).toMatchObject({ runId: snapshot.runId });
	const publication = await raw
		.prepare("SELECT payload FROM refresh_publications WHERE account_id='a'")
		.first<{ payload: string }>();
	expect(JSON.parse(publication?.payload ?? "null")).toEqual(await publishedFactory(db, "a"));
	await db
		.prepare("INSERT INTO factory_state(account_id,published_id,next_at) VALUES('a','retired','t')")
		.run();
	const version = { ...snapshot, runId: "saved-version" };
	await db.batch(await savedObservationStmts(db, "a", "factory", version, snapshot.fetched_at));
	expect(await publishedFactory(db, "a")).toMatchObject({ runId: "saved-version" });
	expect((await raw.prepare("SELECT id FROM factory_runs").all()).results).toEqual([]);
});
