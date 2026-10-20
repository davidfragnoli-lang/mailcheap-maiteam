import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// maiteam (PATCHES.md P6): a welcome sequence, ordered steps timed in whole days from a contact's confirmed enrollment
// (lib/maiteam/sequence-plan.js). Same collection as the old fork's, so its documents carry over once they have an
// accountId.
const stepSchema = new mongoose.Schema(
	{
		position: { type: Number, required: true },
		delayDays: { type: Number, required: true },
		delayFromEnrollmentMs: { type: Number, required: true },
		// Step 1 may send the newsletter's saved welcome email instead of its own words.
		useWelcome: { type: Boolean, default: false },
		subject: { type: String, trim: true, default: "" },
		previewText: { type: String, trim: true, default: "" },
		markdown: { type: String, default: "" },
	},
	{ _id: false }
);

const counter = { type: Number, default: 0 };

const sequenceSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		slug: { type: String, required: true, lowercase: true, trim: true },
		status: { type: String, enum: ["draft", "active", "paused"], default: "draft" },
		pauseReason: { type: String, trim: true },
		steps: { type: [stepSchema], required: true },
		stats: {
			sent: counter,
			delivered: counter,
			bounced: counter,
			complained: counter,
			failed: counter,
		},
	},
	{ timestamps: true }
);

sequenceSchema.plugin(accountScoped);
sequenceSchema.index({ accountId: 1, newsletterId: 1, slug: 1 }, { unique: true });
sequenceSchema.index({ accountId: 1, newsletterId: 1, createdAt: -1 });

export default mongoose.models.Sequence || mongoose.model("Sequence", sequenceSchema);
