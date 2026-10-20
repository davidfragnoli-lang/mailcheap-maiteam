import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// maiteam (PATCHES.md P6): one contact's place in one sequence. The step statuses are the state machine in
// lib/maiteam/sequence-handoff.js and lib/maiteam/sequence-store.js. Same collection as the old fork's.
export const ENROLLMENT_STEP_STATUSES = ["pending", "scheduled", "held", "claimed", "sending", "in-flight", "sent", "skipped", "failed", "cancelled"];
export const ENROLLMENT_STATUSES = ["awaiting_confirmation", "active", "completed", "cancelled"];

const stepSchema = new mongoose.Schema(
	{
		position: { type: Number, required: true },
		status: { type: String, enum: ENROLLMENT_STEP_STATUSES, default: "pending" },
		scheduledFor: { type: String },
		sentAt: { type: Date },
		messageId: { type: String },
	},
	{ _id: false }
);

const enrollmentSchema = new mongoose.Schema(
	{
		sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: "Sequence", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		email: { type: String, required: true, lowercase: true, trim: true },
		status: { type: String, enum: ENROLLMENT_STATUSES, default: "active" },
		enrolledAt: { type: Date, required: true },
		steps: { type: [stepSchema], required: true },
	},
	{ timestamps: true }
);

enrollmentSchema.plugin(accountScoped);
enrollmentSchema.index({ accountId: 1, sequenceId: 1, contactId: 1 }, { unique: true });
enrollmentSchema.index({ accountId: 1, contactId: 1, status: 1 });
enrollmentSchema.index({ accountId: 1, sequenceId: 1, createdAt: -1 });

export default mongoose.models.Enrollment || mongoose.model("Enrollment", enrollmentSchema);
