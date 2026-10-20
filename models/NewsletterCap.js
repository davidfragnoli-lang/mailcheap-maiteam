import mongoose from "mongoose";

// One document per newsletter per UTC day. The id is `newsletterId:YYYY-MM-DD`.
const holdSchema = new mongoose.Schema(
	{
		key: { type: String, required: true },
		amount: { type: Number, required: true },
	},
	{ _id: false }
);

const newsletterCapSchema = new mongoose.Schema(
	{
		_id: { type: String },
		revision: { type: Number, required: true },
		issued: { type: Number, required: true },
		holds: { type: [holdSchema], default: [] },
	},
	{ collection: "newsletter_daily_caps", versionKey: false }
);

export default mongoose.models.NewsletterCap || mongoose.model("NewsletterCap", newsletterCapSchema);
