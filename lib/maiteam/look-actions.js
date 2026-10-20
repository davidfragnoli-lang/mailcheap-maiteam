import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput } from "@/lib/actions/shared";
import {
	COLOR_LABELS,
	FOOTER_TONES,
	MAX_WORDMARK_LENGTH,
	THEME_COLOR_KEYS,
	THEME_FONTS,
	THEME_LAYOUTS,
	THEME_PRESETS,
	THEME_PRODUCTS,
	completeTheme,
	parseThemeInput,
} from "@/lib/maiteam/email-look";
import Newsletter from "@/models/Newsletter";

// maiteam (PATCHES.md P3c): the email look as the API, MCP and the dashboard send it. Left-out fields take the look's
// preset values; the whole look is then checked by the ported parseThemeInput, and stored as it returns it.
const colorInput = z.string().trim().max(20).nullable().optional();

function colorsInput(mode) {
	return Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, colorInput.describe(`${mode} ${COLOR_LABELS[key]} colour, #rrggbb`)]));
}

export const LookInput = z.object({
	preset: z
		.enum(THEME_PRESETS)
		.describe("default: upstream's email. landing: paper, a lighter card, Georgia text, grotesk headlines, orange links and rule, a text wordmark. letter: white, the subject as a serif headline, navy links. maiteam: ground and ink, Helvetica, the product's colours."),
	product: z.enum(THEME_PRODUCTS).optional().describe("maiteam only: whose mail it is. Default: company."),
	layout: z.enum(THEME_LAYOUTS).optional().describe("plain: text on the page. card: a card on the page."),
	headingFont: z.enum(THEME_FONTS).optional().describe("Headline font, one every mail app has"),
	bodyFont: z.enum(THEME_FONTS).optional().describe("Text font, one every mail app has"),
	wordmark: z.string().max(200).optional().describe(`Set in type at the top of every email, ${MAX_WORDMARK_LENGTH} characters at most. Empty shows none.`),
	titleFromSubject: z.boolean().optional().describe("Shows the subject as the email's headline"),
	footerTone: z.enum(FOOTER_TONES).optional().describe("quiet: the muted colour. plain: the text colour."),
	light: z.object(colorsInput("Light")).optional().describe("The colours everyone sees"),
	dark: z
		.object({ enabled: z.boolean().optional().describe("Dark colours for mail apps that follow the reader's setting"), ...colorsInput("Dark") })
		.optional()
		.describe("Dark mode"),
});

const colorsOutput = Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, z.string()]));
export const LookOutput = z.object({
	preset: z.string(),
	product: z.string().optional(),
	layout: z.string(),
	headingFont: z.string(),
	bodyFont: z.string(),
	wordmark: z.string(),
	titleFromSubject: z.boolean(),
	footerTone: z.string(),
	light: z.object(colorsOutput),
	dark: z.object({ enabled: z.boolean(), ...colorsOutput }),
});

// The look to store, or null for none. A maiteam look sent without a product is company mail, as on the old fork.
export function readLookInput(look) {
	if (look === null || look === undefined) return null;
	const product = look.preset === "maiteam" ? (look.product ?? "company") : look.product;
	const { theme, error } = parseThemeInput(completeTheme({ ...look, ...(product && { product }) }));
	if (error) throw actionError("validation_failed", error);
	return theme;
}

export const lookActions = [
	defineAction({
		name: "update_newsletter_email_look",
		tryWithoutPlan: true,
		title: "Set a newsletter's email look",
		group: "Newsletters",
		description:
			"Sets the look of a newsletter's emails: landing, letter or maiteam with its fonts, colours, dark mode, layout, wordmark, headline and footer. Its emails take it instead of the theme's email colours; its website keeps the theme. look: null takes it away. An issue with its own look (update_campaign's look) keeps it.",
		http: { method: "PATCH", path: "/newsletters/{id}/email-look" },
		idempotent: true,
		example: { look: { preset: "landing", wordmark: "Field notes" } },
		input: z.object({
			id: idInput("newsletter").describe("The newsletter's ID or slug"),
			look: LookInput.nullable().describe("The look, or null for the theme's emails"),
		}),
		output: z.object({ id: z.string(), look: LookOutput.nullable() }),
		handler: async ({ account, input }) => {
			const newsletter = await findNewsletter(account, input.id, { _id: 1 });
			const look = readLookInput(input.look);
			const { matchedCount } = await Newsletter.updateOne(
				scoped(account, { _id: newsletter._id }),
				look ? { $set: { "theme.look": look } } : { $unset: { "theme.look": 1 } },
				{ runValidators: true }
			);
			if (!matchedCount) throw actionError("not_found", "Newsletter not found");
			return { id: String(newsletter._id), look };
		},
	}),
];
