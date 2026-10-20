import mongoose from "mongoose";

// One document per newsletter per normalized sender domain. The id is `newsletterId:domain`.
// It records the warm-up level only; daily counts stay in newsletter_daily_caps.
const stepSchema = new mongoose.Schema(
	{
		level: { type: Number, required: true },
		startedAt: { type: Number },
		endedAt: { type: Number },
		accepted: { type: Number },
		bounced: { type: Number },
		complained: { type: Number },
	},
	{ _id: false }
);

const senderWarmupSchema = new mongoose.Schema(
	{
		_id: { type: String },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		domain: { type: String, required: true },
		revision: { type: Number, required: true },
		startedAt: { type: Number, default: null },
		level: { type: Number, default: 0 },
		levelStartedAt: { type: Number, default: null },
		checkedAt: { type: Number, default: null },
		hold: { type: mongoose.Schema.Types.Mixed, default: null },
		history: { type: [stepSchema], default: [] },
	},
	{ collection: "sender_warmups", versionKey: false }
);

senderWarmupSchema.index({ newsletterId: 1 });

export default mongoose.models.SenderWarmup || mongoose.model("SenderWarmup", senderWarmupSchema);
