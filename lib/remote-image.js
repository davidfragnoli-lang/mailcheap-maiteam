import "server-only";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

// Addresses a server must never fetch for a customer: loopback, private networks, link-local (cloud
// metadata), carrier-grade NAT, documentation, multicast and reserved ranges.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
]) {
	BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
]) {
	BLOCKED.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return !BLOCKED.check(address, "ipv4");
	if (family !== 6) return false;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	return mapped ? isPublicAddress(mapped) : !BLOCKED.check(address, "ipv6");
}

function imageError(message) {
	return Object.assign(new Error(message), { code: "validation_failed" });
}

// Checked when the connection opens, so a host can't answer the check with one address and the
// download with another.
function publicLookup(hostname, options, callback) {
	dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) return callback(error);
		if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
			return callback(imageError("The image link points at an address mailcheap can't reach"));
		}
		if (options.all) return callback(null, addresses);
		return callback(null, addresses[0].address, addresses[0].family);
	});
}

function get(url) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { lookup: publicLookup, timeout: TIMEOUT_MS, headers: { accept: "image/*" } }, resolve);
		request.on("timeout", () => request.destroy(imageError("The image link took too long to answer")));
		request.on("error", reject);
	});
}

async function readBody(response, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of response) {
		size += chunk.length;
		if (size > maxBytes) {
			response.destroy();
			throw imageError("Images must be under 4 MB");
		}
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

export async function fetchRemoteImage(link, { maxBytes }) {
	let url;
	try {
		url = new URL(link);
	} catch {
		throw imageError("url must be an https:// link");
	}
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
			throw imageError("url must be an https:// link on the standard port");
		}
		if (net.isIP(hostname) && !isPublicAddress(hostname)) throw imageError("The image link points at an address mailcheap can't reach");

		const response = await get(url);
		const location = response.headers.location;
		if (response.statusCode >= 300 && response.statusCode < 400 && location) {
			response.resume();
			url = new URL(location, url);
			continue;
		}
		if (response.statusCode !== 200) {
			response.resume();
			throw imageError(`The image link answered ${response.statusCode}`);
		}
		if (Number(response.headers["content-length"]) > maxBytes) {
			response.destroy();
			throw imageError("Images must be under 4 MB");
		}
		return readBody(response, maxBytes);
	}
	throw imageError("The image link redirects too many times");
}
