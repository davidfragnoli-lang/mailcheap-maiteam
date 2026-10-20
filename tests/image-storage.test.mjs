import assert from "node:assert/strict";
import { test } from "node:test";
import { withEnv } from "./helpers/app.mjs";
import { clients, objects } from "./stubs/s3.mjs";
import { stored as blobs } from "./stubs/vercel-blob.mjs";

const { getImageStorage, getImageStorageProblem, putImage } = await import("../lib/image-storage.js");

const S3 = {
	IMAGES_S3_BUCKET: "mailcheap-images-test",
	IMAGES_S3_ACCESS_KEY_ID: "images-key-id",
	IMAGES_S3_SECRET_ACCESS_KEY: "images-secret",
	IMAGES_CDN_URL: "https://cdn.example.com/",
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("new images go to S3 when its bucket is set, else to Vercel Blob, else uploads are off", () => {
	assert.equal(getImageStorage({ ...S3, BLOB_READ_WRITE_TOKEN: "blob" }), "s3");
	assert.equal(getImageStorage({ BLOB_READ_WRITE_TOKEN: "blob" }), "blob");
	assert.equal(getImageStorage({}), null);
	assert.equal(getImageStorageProblem(S3), null);
	assert.equal(getImageStorageProblem({ BLOB_READ_WRITE_TOKEN: "blob" }), null);
	assert.match(getImageStorageProblem({}), /IMAGES_S3_BUCKET.*BLOB_READ_WRITE_TOKEN/);
});

test("a bucket without its keys or CDN says what's missing, instead of quietly using Blob", () => {
	assert.equal(
		getImageStorageProblem({ IMAGES_S3_BUCKET: "mailcheap-images-test", BLOB_READ_WRITE_TOKEN: "blob" }),
		"IMAGES_S3_BUCKET is set, so IMAGES_S3_ACCESS_KEY_ID, IMAGES_S3_SECRET_ACCESS_KEY, IMAGES_CDN_URL have to be set too"
	);
	assert.equal(getImageStorageProblem({ ...S3, IMAGES_CDN_URL: "" }), "IMAGES_S3_BUCKET is set, so IMAGES_CDN_URL has to be set too");
	assert.equal(getImageStorageProblem({ ...S3, IMAGES_CDN_URL: "http://cdn.example.com" }), "IMAGES_CDN_URL must be an https:// URL");
});

test("S3 uploads get a name of their own in the folder, a year of cache, and the CDN's URL, with mailcheap's keys only", async () => {
	const env = { ...S3, AWS_ACCESS_KEY_ID: "machine-key", AWS_SECRET_ACCESS_KEY: "machine-secret", AWS_PROFILE: "main" };
	const first = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));
	const second = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));

	assert.match(first.pathname, /^accounts\/abc\/images\/cover-[0-9a-f]{16}\.png$/);
	assert.notEqual(first.pathname, second.pathname, "the same name twice never replaces the first file");
	assert.equal(first.url, `https://cdn.example.com/${first.pathname}`);
	assert.deepEqual(
		objects.map(({ Bucket, Key, ContentType, CacheControl, bytes }) => ({ Bucket, Key, ContentType, CacheControl, bytes })),
		[first, second].map(({ pathname }) => ({
			Bucket: "mailcheap-images-test",
			Key: pathname,
			ContentType: "image/png",
			CacheControl: "public, max-age=31536000, immutable",
			bytes: PNG.length,
		}))
	);
	assert.equal(blobs.length, 0);
	assert.equal(clients.length, 1, "one client for every upload");
	assert.deepEqual(clients[0].config, {
		region: "us-east-1",
		credentials: { accessKeyId: "images-key-id", secretAccessKey: "images-secret" },
	});
});

test("without S3, images go to Vercel Blob as before", async () => {
	const s3Count = objects.length;
	const stored = await withEnv({ BLOB_READ_WRITE_TOKEN: "blob-test" }, () => putImage("accounts/abc/images/logo.png", PNG, "image/png"));
	assert.equal(stored.url, `https://blob.example.com/${stored.pathname}`);
	assert.deepEqual(blobs.at(-1).options, {
		access: "public",
		contentType: "image/png",
		addRandomSuffix: true,
		cacheControlMaxAge: 31536000,
	});
	assert.equal(objects.length, s3Count, "nothing went to S3");
});
