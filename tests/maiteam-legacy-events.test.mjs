import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { startTestApp } from "./helpers/app.mjs";

// PATCHES.md P8b: a bounce or complaint for an email sent before the move onto upstream has no account tag.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		events: await import("../lib/ses-events.js"),
		Message: (await import("../models/Message.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
		Contact: (await import("../models/Contact.js")).default,
	};
});

after(() => app?.stop());

// What the old fork's emails carry: a message id tag, no account_id.
function sesBounce(providerMessageId, email) {
	return {
		eventType: "Bounce",
		mail: { messageId: providerMessageId, tags: { message_id: ["x"] }, destination: [email] },
		bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: email, diagnosticCode: "550 5.1.1 User unknown" }], timestamp: new Date().toISOString() },
	};
}

test("a hard bounce for a pre-migration email, without an account tag, still suppresses in its account", async () => {
	const accountId = new mongoose.Types.ObjectId();
	const newsletterId = new mongoose.Types.ObjectId();
	const contact = await m.Contact.create({ accountId, newsletterId, email: "old@reader.example.org", status: "active" });
	await m.Message.create({ accountId, newsletterId, contactId: contact._id, kind: "campaign", email: contact.email, status: "sent", providerMessageId: "old-ses-id-1", sentAt: new Date(), migratedFromFork: true });
	await m.events.handleSesEvent(sesBounce("old-ses-id-1", contact.email));
	assert.ok(await m.Suppression.exists({ accountId, email: contact.email }), "suppressed in the message's own account");
	assert.equal((await m.Message.findOne({ accountId, providerMessageId: "old-ses-id-1" }).lean()).status, "bounced");
});

test("an untagged event changes nothing for an email this server never sent, or one upstream's code sent", async () => {
	const accountId = new mongoose.Types.ObjectId();
	const newsletterId = new mongoose.Types.ObjectId();
	await m.Message.create({ accountId, newsletterId, kind: "campaign", email: "new@reader.example.org", status: "sent", providerMessageId: "tagged-era-id", sentAt: new Date() });
	const before = await m.Suppression.countDocuments({}).setOptions({ crossAccount: true });
	await m.events.handleSesEvent(sesBounce("someone-elses-id", "stranger@example.org"));
	await m.events.handleSesEvent(sesBounce("tagged-era-id", "new@reader.example.org"));
	assert.equal(await m.Suppression.countDocuments({}).setOptions({ crossAccount: true }), before);
});
