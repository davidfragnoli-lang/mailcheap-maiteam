import * as z from "zod";
import { OWNER_ROLE, TEAM_ROLES } from "../team-rules.js";

export const KEY_LEVELS = ["full", "signups"];
const ROLES = [OWNER_ROLE, ...TEAM_ROLES];
const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const NAME_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;
const PATH_PATTERN = /^(?:\/(?:[a-z][a-z-]*|\{[a-zA-Z]+\}))+$/;

function assert(condition, name, message) {
	if (!condition) throw new Error(`Action ${name}: ${message}`);
}

// One customer action, written once: the dashboard, the REST API and the MCP server all run it through
// runAction. permission "signups" opens it to signups only keys too; everything else needs full access, except that
// read only keys run the read-only GET actions (canKeyUse).
// The four hints are MCP's tool annotations: readOnly never changes anything, destructive can't be undone,
// idempotent means a repeat call adds no effect, openWorld reaches outside MailCheap (email, Stripe, DNS).
// example: an input the docs show in the request example. tryWithoutPlan: the dashboard runs it for an account
// without a plan, which can set up its newsletter and write before paying; the REST API and MCP still need one.
// whileBlocked: a blocked account (lib/account-blocks.js) can still run it. Reads can; of the changes, only those
// that stop something or leave: pausing, unscheduling, revoking access, the billing portal, and marking its
// notifications read or clearing them, one of which tells it of the block. dashboardInput: fields only the
// dashboard sends on top of input, like a box its user ticked; the REST API and MCP never take them, and the docs
// don't show them. rateLimit: the calls each API key or connected app gets in a window, and its account gets across
// all of them. limitDashboard: the dashboard's calls count against the account's too. By default the actions that
// reach outside MailCheap, where every call costs something; a function of the input picks the calls that count.
// role: who on a newsletter's team (lib/team-rules.js) runs it from the dashboard, on that newsletter: member, admin, or
// owner, the default, the account's owner alone, for what the whole account shares, like billing, domains, keys and teams.
export function defineAction({
	name,
	title,
	description,
	group,
	http,
	input = z.object({}),
	dashboardInput = null,
	output,
	example = {},
	permission = "full",
	readOnly = false,
	destructive = false,
	idempotent = readOnly,
	openWorld = false,
	requiresPlan = true,
	tryWithoutPlan = false,
	whileBlocked = readOnly,
	rateLimit = null,
	limitDashboard = openWorld,
	role = OWNER_ROLE,
	handler,
}) {
	assert(NAME_PATTERN.test(name ?? ""), name, "name must be snake_case");
	assert(title && description && group, name, "title, description and group are required");
	assert(METHODS.includes(http?.method) && PATH_PATTERN.test(http?.path ?? ""), name, "http needs a method and a path");
	assert(input instanceof z.ZodObject && output instanceof z.ZodObject, name, "input and output must be z.object schemas");
	assert(dashboardInput === null || dashboardInput instanceof z.ZodObject, name, "dashboardInput must be a z.object schema");
	assert(KEY_LEVELS.includes(permission), name, `permission must be one of ${KEY_LEVELS.join(", ")}`);
	assert(ROLES.includes(role), name, `role must be one of ${ROLES.join(", ")}`);
	assert(!(readOnly && destructive), name, "a read-only action can't be destructive");
	assert(typeof handler === "function", name, "handler is required");
	assert(input.partial().safeParse(example).success, name, "example must match the input");
	return Object.freeze({
		name,
		title,
		description,
		group,
		http: Object.freeze({ status: 200, ...http }),
		input,
		dashboardInput,
		output,
		example,
		permission,
		readOnly,
		destructive,
		idempotent,
		openWorld,
		requiresPlan,
		tryWithoutPlan,
		whileBlocked,
		rateLimit,
		limitDashboard,
		role,
		handler,
	});
}

// Path parameters, e.g. ["id"] for /campaigns/{id}.
export function getPathParams(path) {
	return [...path.matchAll(/\{([a-zA-Z]+)\}/g)].map(([, param]) => param);
}

// maiteam (PATCHES.md P18): readOnly GET actions a read only key still can't run, because they do more than read. The
// annotations stay as they are, since they also set rate limits and whileBlocked for full keys. Add here any readOnly GET
// that mints a link working without the key, or calls outside MailCheap.
export const READ_KEY_EXCLUDED = new Set([
	// A 1-hour export.csv link: the download checks only its token, so it works without the key, even once it's revoked.
	"export_contacts",
	// The summary's settings and one-click links: 180-day tokens that change the summary without the key.
	"preview_summary_email",
	// Reads the plans' prices from Stripe whenever its cache is cold.
	"get_billing",
]);

// A read only key runs what changes nothing and reaches nothing outside MailCheap (openWorld reads cost something per
// call), through GET alone, except READ_KEY_EXCLUDED: every write is refused, whatever its permission.
export function canKeyUse(level, action) {
	if (level === "read") return action.readOnly && !action.openWorld && action.http.method === "GET" && !READ_KEY_EXCLUDED.has(action.name);
	return level === "full" || action.permission === "signups";
}
