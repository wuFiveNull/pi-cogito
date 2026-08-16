import { getLoadablePath } from "sqlite-vec";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, type SqliteDatabase } from "../../../storage/sqlite-node/src/index.ts";

let vecPath: string | undefined;
try {
	vecPath = getLoadablePath();
} catch {
	vecPath = undefined;
}

async function loadVecExtension(db: SqliteDatabase): Promise<void> {
	if (!db.loadExtension) throw new Error("SqliteDatabase.loadExtension not implemented");
	await db.loadExtension(vecPath!);
}

const maybe = vecPath ? describe : describe.skip;

maybe("sqlite-vec extension loading through SqliteDatabase", () => {
	it("loads vec0 and runs KNN queries", async () => {
		const factory = createNodeSqliteFactory();
		const db = await factory.open(":memory:");
		await loadVecExtension(db);
		await db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])");

		const insert = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)");
		await insert.run(1n, new Float32Array([0.1, 0.2, 0.3]));
		await insert.run(2n, new Float32Array([0.9, 0.8, 0.7]));
		await insert.run(3n, new Float32Array([0.2, 0.1, 0.4]));

		const rows = await db
			.prepare("SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
			.all<{ rowid: number; distance: number }>(new Float32Array([0.15, 0.18, 0.35]));
		expect(rows).toEqual([
			{ rowid: 1, distance: expect.closeTo(0.0735, 3) },
			{ rowid: 3, distance: expect.closeTo(0.1068, 3) },
		]);
		await db.close();
	});

	it("rejects non-integer rowids (node:sqlite binds numbers as REAL)", async () => {
		const factory = createNodeSqliteFactory();
		const db = await factory.open(":memory:");
		await loadVecExtension(db);
		await db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])");

		await expect(
			db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)").run(1, new Float32Array([0.1, 0.2, 0.3])),
		).rejects.toThrow(/Only integers/);
		await db.close();
	});

	it("is idempotent for repeated loads of the same extension", async () => {
		const factory = createNodeSqliteFactory();
		const db = await factory.open(":memory:");
		await loadVecExtension(db);
		await loadVecExtension(db);
		await db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])");
		await db.close();
	});

	it("requires loadExtension before vec0 tables can be created", async () => {
		const factory = createNodeSqliteFactory();
		const db = await factory.open(":memory:");
		await expect(db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])")).rejects.toThrow(
			/no such module/,
		);
		await db.close();
	});
});
