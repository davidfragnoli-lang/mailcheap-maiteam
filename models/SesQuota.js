import mongoose from "mongoose";

// One document for the whole install. `reserved` is derived from unsent holds plus
// sends handed to SES that SentLast24Hours has not absorbed yet.
const holdSchema = new mongoose.Schema(
	{
		key: { type: String, required: true },
		amount: { type: Number, required: true },
	},
	{ _id: false }
);

const sesQuotaSchema = new mongoose.Schema(
	{
		_id: { type: String },
		revision: { type: Number, required: true },
		reserved: { type: Number, required: true },
		issued: { type: Number, required: true },
		accountedSent: { type: Number, default: null },
		holds: { type: [holdSchema], default: [] },
	},
	{ collection: "ses_quota_holds", versionKey: false }
);

export default mongoose.models.SesQuota || mongoose.model("SesQuota", sesQuotaSchema);
