# Disposable email domains (vendored)

- Source: https://github.com/disposable-email-domains/disposable-email-domains
- File: `disposable_email_blocklist.conf` (the blocklist; the upstream allowlist is not used)
- Pinned commit: `d1a9c51f29de15e8dab2f5ed8bda90a711ef6cb9` (2026-10-13, "Add missing domains from sources (#1214)")
- Retrieved: 2026-10-14
- sha256: `bf235abe3d827cc9510a5cb4faedb0e1a7c5df88b7ad9437fd03d3770d826e1e`, 9,881 domains
- License: CC0 1.0 Universal, copied as `LICENSE.txt` from the same commit

`lib/maiteam/disposable-domains-data.js` is generated from this file and records the same sha256.
`tests/maiteam-email-check.test.mjs` fails if the two drift apart.

## Update

1. Pick the latest upstream commit on `main` and read its diff. Look for removals of mainstream
   providers and for bulk additions you can't explain.
2. `node scripts/maiteam/update-disposable-domains.mjs <full 40-character sha>`
3. Edit this file: commit, date, sha256 and count the script printed.
4. `npm test`, then commit the list, `LICENSE.txt`, this file and `lib/maiteam/disposable-domains-data.js` together.

Monthly is enough. A domain wrongly listed upstream blocks real people until the next update, so if
someone reports one, remove it from the vendored file, regenerate without a sha, and note it here.
