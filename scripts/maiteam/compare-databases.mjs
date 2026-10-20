// P8 restore proof (PATCHES.md): two databases, collection by collection. Each document is compared whole (its
// canonical content hash, by id), and so is each collection's set of indexes. Prints counts and hashes only.
//
//   COMPARE_URI=mongodb://127.0.0.1:<port> node scripts/maiteam/compare-databases.mjs <db-a> <db-b>

import mongoose from "mongoose";
import { compareContent, contentDigest, indexSpecs, sha256 } from "./integrity.mjs";

export async function summarize(db) {
	const out = {};
	for (const { name } of await db.listCollections().toArray()) {
		if (name.startsWith("system.")) continue;
		const docs = await db.collection(name).find({}).toArray();
		const { count, content } = contentDigest(docs);
		out[name] = { count, content, indexes: sha256(JSON.stringify(await indexSpecs(db.collection(name)))), docs };
	}
	return out;
}

export async function compareDatabases(first, second) {
	const [a, b] = [await summarize(first), await summarize(second)];
	const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	const collections = {};
	for (const name of names) {
		const [left, right] = [a[name], b[name]];
		const documents = compareContent(left?.docs ?? [], right?.docs ?? []);
		const indexesSame = Boolean(left && right && left.indexes === right.indexes);
		collections[name] = {
			[first.databaseName]: left ? { count: left.count, content: left.content, indexes: left.indexes } : null,
			[second.databaseName]: right ? { count: right.count, content: right.content, indexes: right.indexes } : null,
			documents: { missing: documents.missing, changed: documents.changed, extra: documents.extra },
			same: documents.same && indexesSame,
		};
	}
	return { compared: [first.databaseName, second.databaseName], same: names.every((name) => collections[name].same), collections };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const [first, second] = process.argv.slice(2);
	if (!first || !second || !process.env.COMPARE_URI) throw new Error("Usage: COMPARE_URI=… compare-databases.mjs <db-a> <db-b>");
	const client = await new mongoose.mongo.MongoClient(process.env.COMPARE_URI).connect();
	try {
		const result = await compareDatabases(client.db(first), client.db(second));
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.same ? 0 : 1;
	} finally {
		await client.close();
	}
}
