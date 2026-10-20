// AGPL-3.0 §13 (PATCHES.md P7): subscribers use this server over the network, so its public pages offer the exact
// source it runs. SOURCE_REPOSITORY_URL is the public repository holding that code without secrets, and the commit
// is the one Vercel built (VERCEL_GIT_COMMIT_SHA). Without a repository URL nothing is linked: the repository stays
// private until David approves its publication, and the link appears only with it.

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function getSourceLink(env = process.env) {
	const repository = String(env.SOURCE_REPOSITORY_URL ?? "").trim().replace(/\/+$/, "");
	if (!/^https:\/\/[^\s/]+\/\S+$/.test(repository)) return null;
	const commit = String(env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
	return SHA_PATTERN.test(commit) ? `${repository}/tree/${commit.toLowerCase()}` : repository;
}
