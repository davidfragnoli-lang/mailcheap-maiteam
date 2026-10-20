import { FOOTER_TONES, HEX_COLOR_PATTERN, MAX_WORDMARK_LENGTH, THEME_FONTS, THEME_LAYOUTS, THEME_PRESETS, THEME_PRODUCTS } from "../lib/maiteam/email-look.js";

const hexColor = { type: String, trim: true, lowercase: true, match: HEX_COLOR_PATTERN };
const themeColors = { page: hexColor, card: hexColor, text: hexColor, accent: hexColor, muted: hexColor };

// maiteam (PATCHES.md P3c): one email look (lib/maiteam/email-look.js), stored on a newsletter (theme.look), on an
// issue (look), or on a sequence step. Unset on a newsletter keeps upstream's email theme; unset on an issue or a step
// takes the newsletter's.
export const lookFields = {
	preset: { type: String, enum: THEME_PRESETS },
	// maiteam only: whose mail it is (company, fortuna, quote-to-invoice). Unset on a maiteam look is company.
	product: { type: String, enum: THEME_PRODUCTS },
	layout: { type: String, enum: THEME_LAYOUTS },
	headingFont: { type: String, enum: THEME_FONTS },
	bodyFont: { type: String, enum: THEME_FONTS },
	// Set in type at the top of the email; never an image.
	wordmark: { type: String, trim: true, maxlength: MAX_WORDMARK_LENGTH },
	titleFromSubject: { type: Boolean },
	footerTone: { type: String, enum: FOOTER_TONES },
	light: themeColors,
	dark: { enabled: { type: Boolean }, ...themeColors },
};
