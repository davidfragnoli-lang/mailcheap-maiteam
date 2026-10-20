// Two databases on one server, collection by collection: document counts and a hash of the sorted ids. Prints JSON
// with counts and hashes only (P8 restore proof).
//
//   COMPARE_URI=mongodb://127.0.0.1:<port> node scripts/maiteam/compare-databases.mjs <db-a> <db-b>

import crypto from "node:crypto";
import mongoose from "mongoose";

const [first, second] = process.argv.slice(2);
if (!first || !second || !process.env.COMPARE_URI) throw new Error("Usage: COMPARE_URI=… compare-databases.mjs <db-a> <db-b>");
const client = await new mongoose.mongo.MongoClient(process.env.COMPARE_URI).connect();
const summarize = async (name) => {
	const db = client.db(name);
	const out = {};
	for (const { name: collection } of await db.listCollections().toArray()) {
		if (collection.startsWith("system.")) continue;
		const ids = (await db.collection(collection).find({}, { projection: { _id: 1 } }).toArray()).map(({ _id }) => String(_id)).sort();
		out[collection] = { count: ids.length, ids: crypto.createHash("sha256").update(ids.join("\n")).digest("hex") };
	}
	return out;
};
const [a, b] = [await summarize(first), await summarize(second)];
const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const collections = Object.fromEntries(names.map((name) => [name, { [first]: a[name] ?? null, [second]: b[name] ?? null, same: JSON.stringify(a[name]) === JSON.stringify(b[name]) }]));
const result = { compared: [first, second], same: names.every((name) => collections[name].same), collections };
console.log(JSON.stringify(result, null, 2));
await client.close();
process.exit(result.same ? 0 : 1);
