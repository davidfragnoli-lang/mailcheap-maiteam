"use client";

import { useActionState, useState } from "react";
import { saveSequenceAction } from "@/app/(app)/sequences/actions";
import FieldStepLook from "@/components/maiteam/FieldStepLook";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { stepsFromDashboardFields } from "@/lib/maiteam/sequence-plan";
import { slugify } from "@/lib/slug";
import { toast } from "@/lib/toast";

const SELECT_CLASS =
	"h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

// maiteam (PATCHES.md P6): a welcome sequence, three steps here (the API takes up to six). The steps go to the server as
// one JSON field, which create_sequence and update_sequence check again.
export default function FormSequence({ sequence, newsletters }) {
	const [name, setName] = useState(sequence?.name ?? "");
	const [slug, setSlug] = useState(sequence?.slug ?? "");
	const [isSlugEdited, setIsSlugEdited] = useState(Boolean(sequence));
	const [newsletterId, setNewsletterId] = useState(sequence?.newsletterId ?? newsletters[0]?.id ?? "");
	const hasWelcome = Boolean(newsletters.find((item) => item.id === newsletterId)?.hasWelcome);
	const saved = sequence?.steps ?? [];
	const [steps, setSteps] = useState(() => [0, 1, 2].map((index) => toFields(saved[index])));
	const [useWelcome, setUseWelcome] = useState(Boolean(saved[0]?.useWelcome) && hasWelcome);
	// maiteam (P3c): each step's own email look; null is the newsletter's.
	const [looks, setLooks] = useState(() => [0, 1, 2].map((index) => saved[index]?.look ?? null));
	const newsletterName = newsletters.find((item) => item.id === newsletterId)?.name ?? "";
	const [, action, isPending] = useActionState(async (previous, formData) => {
		const result = await saveSequenceAction(previous, formData);
		if (result?.error) toast.error(result.error);
		else if (result?.ok) toast.success("Saved");
		return result;
	}, null);

	const parsed = stepsFromDashboardFields(
		Object.fromEntries(
			steps.flatMap((step, index) => [
				[`step${index + 1}Delay`, step.delayDays],
				[`step${index + 1}Subject`, step.subject],
				[`step${index + 1}Preview`, step.previewText],
				[`step${index + 1}Markdown`, step.markdown],
				[`step${index + 1}Look`, looks[index]],
			]).concat([["step1UseWelcome", useWelcome]])
		)
	);

	function update(index, key) {
		return (event) => {
			const { value } = event.target;
			setSteps((current) => current.map((step, stepIndex) => (stepIndex === index ? { ...step, [key]: value } : step)));
		};
	}

	function submit(event) {
		if (parsed.ok) return;
		event.preventDefault();
		toast.error(parsed.error);
	}

	return (
		<form action={action} onSubmit={submit} className="flex flex-col gap-4">
			{sequence && <input type="hidden" name="id" value={sequence.id} />}
			<input type="hidden" name="steps" value={parsed.ok ? JSON.stringify(parsed.steps) : ""} />
			<Section title="Sequence">
				<Field label="Name">
					<Input
						name="name"
						value={name}
						required
						placeholder="Welcome"
						onChange={(event) => {
							setName(event.target.value);
							if (!isSlugEdited) setSlug(slugify(event.target.value, 40));
						}}
					/>
				</Field>
				<Field label="Slug" hint="Pass this as sequence when you add a contact through the API.">
					<Input
						name="slug"
						value={slug}
						required
						placeholder="welcome"
						className="font-mono"
						onChange={(event) => {
							setSlug(event.target.value);
							setIsSlugEdited(true);
						}}
					/>
				</Field>
				<Field label="Newsletter">
					<select
						name="newsletter"
						value={newsletterId}
						disabled={Boolean(sequence)}
						required
						onChange={(event) => setNewsletterId(event.target.value)}
						className={SELECT_CLASS}
					>
						{newsletters.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
				</Field>
				<Field label="Status" hint="Saving doesn't send anything. Start or Resume does, and only while sending is on.">
					<select name="status" defaultValue={sequence?.status ?? "draft"} className={SELECT_CLASS}>
						<option value="draft">Draft</option>
						<option value="active">Active</option>
						<option value="paused">Paused</option>
					</select>
				</Field>
			</Section>

			{steps.map((step, index) => (
				<Section
					key={index}
					title={`Step ${index + 1}`}
					note={
						index === 0
							? "Days count from the signup, or from the confirmation click when the newsletter asks new subscribers to confirm. A later day makes the confirmation email the first mail."
							: "Leave every field empty to leave this step out. Each step comes on a later day than the one before."
					}
				>
					<Field label="Day">
						<Input value={step.delayDays} onChange={update(index, "delayDays")} inputMode="numeric" placeholder={index === 0 ? "0" : String(index * 2)} />
					</Field>
					{index === 0 && (
						<Field label="Welcome email">
							<span className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={useWelcome}
									disabled={!hasWelcome && !useWelcome}
									onChange={(event) => setUseWelcome(event.target.checked)}
								/>
								Send the newsletter&apos;s saved welcome email, on day 0
							</span>
							{!hasWelcome && <span className="text-xs text-muted-foreground">Save a welcome email in the newsletter&apos;s settings first.</span>}
						</Field>
					)}
					{!(index === 0 && useWelcome) && (
						<>
							<Field label="Subject">
								<Input value={step.subject} onChange={update(index, "subject")} />
							</Field>
							<Field label="Preview">
								<Input value={step.previewText} onChange={update(index, "previewText")} />
							</Field>
							<Field label="Content">
								<Textarea value={step.markdown} onChange={update(index, "markdown")} className="min-h-32 font-mono" />
							</Field>
						</>
					)}
					<Field label="Email look">
						<FieldStepLook
							value={looks[index]}
							newsletterName={newsletterName}
							onChange={(next) => setLooks((current) => current.map((look, lookIndex) => (lookIndex === index ? next : look)))}
						/>
					</Field>
				</Section>
			))}

			<div className="flex justify-end">
				<Button type="submit" disabled={isPending || newsletters.length === 0}>
					{isPending ? "Saving" : "Save"}
				</Button>
			</div>
		</form>
	);
}

function toFields(step) {
	return {
		delayDays: step ? String(step.delayDays) : "",
		subject: step?.subject ?? "",
		previewText: step?.previewText ?? "",
		markdown: step?.markdown ?? "",
	};
}

function Section({ title, note, children }) {
	return (
		<section className="rounded-xl bg-card shadow-border">
			<div className="flex flex-col gap-1 px-4 py-3">
				<h2 className="text-sm font-medium">{title}</h2>
				{note && <p className="text-xs text-pretty text-muted-foreground">{note}</p>}
			</div>
			<div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
		</section>
	);
}

function Field({ label, hint, children }) {
	return (
		<label className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<span className="text-sm text-muted-foreground sm:pt-2">{label}</span>
			<span className="flex flex-col gap-1.5">
				{children}
				{hint && <span className="text-xs text-muted-foreground">{hint}</span>}
			</span>
		</label>
	);
}
