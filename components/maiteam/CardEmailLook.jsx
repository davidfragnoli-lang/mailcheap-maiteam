"use client";

import { useDeferredValue, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { saveEmailLook } from "@/app/(app)/newsletters/actions";
import CardSettings from "@/components/CardSettings";
import PickerLook, { SAMPLE_EMAIL_MARKDOWN, SchemeToggle, describeLook } from "@/components/maiteam/PickerLook";
import PreviewEmail from "@/components/PreviewEmail";
import { Button } from "@/components/ui/button";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "@/lib/render-email";
import { toast } from "@/lib/toast";

const INHERIT = {
	label: "The theme's",
	theme: null,
	hint: "Emails follow the theme above. Pick a look for them only, or change a colour below.",
};

// maiteam (PATCHES.md P3c): the newsletter's email look, on the Design page under the themes. Without one, emails
// follow the theme above; with one, they take the look and the website keeps the theme.
export default function CardEmailLook({ newsletter, postalAddress }) {
	const [saved, setSaved] = useState(newsletter.theme?.look ?? null);
	const [look, setLook] = useState(saved);
	const [scheme, setScheme] = useState("light");
	const [isSaving, startSaving] = useTransition();
	const isDirty = JSON.stringify(look) !== JSON.stringify(saved);
	const deferredLook = useDeferredValue(look);
	const html = useMemo(
		() =>
			renderEmail({
				markdown: `${SAMPLE_EMAIL_MARKDOWN}\n\n<a href="https://example.com" data-button>Read the issue</a>`,
				subject: "This week",
				newsletter: { name: newsletter.name, postalAddress, theme: { ...newsletter.theme, look: deferredLook } },
				previewScheme: scheme,
			}).html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"),
		[deferredLook, newsletter.name, newsletter.theme, postalAddress, scheme]
	);

	function save() {
		const next = look;
		startSaving(async () => {
			const result = await saveEmailLook(newsletter._id, next);
			if (result?.error) return void toast.error(result.error);
			setSaved(result.look);
			setLook(result.look);
			toast.success("Email look saved");
		});
	}

	return (
		<CardSettings
			title="Email look"
			className="mt-8"
			action={
				<span className="flex items-center gap-2">
					<span className="truncate text-xs text-muted-foreground">{saved ? describeLook(saved) : "The theme's"}</span>
					<Button type="button" size="sm" onClick={save} disabled={!isDirty || isSaving}>
						{isSaving && <Loader2 className="animate-spin" />}
						Save
					</Button>
				</span>
			}
		>
			<div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<PickerLook value={look} onChange={setLook} inherit={INHERIT} newsletterName={newsletter.name}>
					<p className="px-4 py-3 text-xs text-pretty text-muted-foreground">
						Emails take this look instead of the theme&apos;s colours and fonts; the website keeps the theme. An issue can pick its own in the editor.
					</p>
				</PickerLook>
				<div className="flex min-h-[32rem] flex-col gap-2 p-4">
					<SchemeToggle value={scheme} onChange={setScheme} />
					<PreviewEmail
						html={html}
						sender={{ name: newsletter.name, fromName: newsletter.fromName, fromEmail: newsletter.fromEmail, imageUrl: newsletter.imageUrl }}
						subject="This week"
						className="min-h-0 flex-1"
					/>
				</div>
			</div>
		</CardSettings>
	);
}
