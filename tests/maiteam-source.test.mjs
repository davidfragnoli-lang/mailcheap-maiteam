import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FooterArchive from "../components/FooterArchive.jsx";
import { getSourceLink } from "../lib/maiteam/source.js";
import { withEnv } from "./helpers/app.mjs";

// AGPL-3.0 §13 (PATCHES.md P7).
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("the source link names the exact commit Vercel built, and nothing without a public repository", () => {
	assert.equal(getSourceLink({}), null, "private until a repository is set");
	assert.equal(getSourceLink({ SOURCE_REPOSITORY_URL: "http://example.com/x" }), null, "https only");
	assert.equal(getSourceLink({ SOURCE_REPOSITORY_URL: "https://github.com/maiteam/mailcheap/", VERCEL_GIT_COMMIT_SHA: SHA }), `https://github.com/maiteam/mailcheap/tree/${SHA}`);
	assert.equal(getSourceLink({ SOURCE_REPOSITORY_URL: "https://github.com/maiteam/mailcheap", VERCEL_GIT_COMMIT_SHA: "not a sha" }), "https://github.com/maiteam/mailcheap");
});

test("the archive footer shows it only once a repository is set", async () => {
	const newsletter = { name: "fortuna", socialLinks: [] };
	const render = () => renderToStaticMarkup(createElement(FooterArchive, { newsletter, indexHref: "/archive/maifortune" }));
	await withEnv({ SOURCE_REPOSITORY_URL: "" }, async () => assert.ok(!render().includes(">Source<")));
	await withEnv({ SOURCE_REPOSITORY_URL: "https://github.com/maiteam/mailcheap", VERCEL_GIT_COMMIT_SHA: SHA }, async () => {
		assert.ok(render().includes(`href="https://github.com/maiteam/mailcheap/tree/${SHA}"`));
	});
});
