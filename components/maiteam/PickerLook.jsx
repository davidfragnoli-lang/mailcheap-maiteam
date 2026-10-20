"use client";

import { useState } from "react";
import { ChevronDown, Moon, Sun, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	COLOR_LABELS,
	FONT_STACKS,
	HEX_COLOR_PATTERN,
	MAX_WORDMARK_LENGTH,
	THEME_COLOR_KEYS,
	THEME_FONT_OPTIONS,
	THEME_LOOKS,
	THEME_PRODUCT_OPTIONS,
	completeTheme,
	contrastProblems,
	presetTheme,
	presetWordmark,
} from "@/lib/maiteam/email-look";
import { cn } from "@/lib/utils";

// What a preview shows while the email itself is still empty.
export const SAMPLE_EMAIL_MARKDOWN =
	"# A headline\n\nA paragraph with a [link](https://example.com) in it, long enough to wrap onto a second line.\n\n:::box\nA box for an aside.\n:::\n\nDavid";

export const SCHEMES = [
	{ id: "light", label: "Light", icon: Sun },
	{ id: "dark", label: "Dark", icon: Moon },
];

// maiteam (PATCHES.md P3c): the old fork's look picker (components/PickerTheme.jsx at 7bdd14c), ported as it was.
// Picks an email look: one of the presets, then the type, any colour, the layout and the wordmark, with a
// WCAG AA warning for colours a reader could not make out. `value` is the stored theme; with `inherit`
// (an issue or a sequence step) it may be null, which means the newsletter's own look, and the first edit
// of a colour turns that look into this document's own.
export default function PickerLook({ value, onChange, inherit, newsletterName = "", compact = false, children }) {
	const [isMoreOpen, setIsMoreOpen] = useState(!compact);
	const isInherited = Boolean(inherit) && !value;
	const theme = completeTheme(value ?? inherit?.theme ?? presetTheme("default"));
	const problems = contrastProblems(theme);
	const look = THEME_LOOKS.find((item) => item.id === theme.preset);

	function chooseLook(id) {
		onChange({ ...presetTheme(id), wordmark: presetWordmark(id, newsletterName) });
	}

	// A maiteam mail names its product here; the product's colours replace the previous ones, and a wordmark
	// still showing the previous product's name follows.
	function chooseProduct(product) {
		const next = presetTheme("maiteam", product);
		const wordmark = theme.wordmark === presetWordmark("maiteam", "", theme.product) ? presetWordmark("maiteam", "", product) : theme.wordmark;
		onChange({ ...theme, product, light: next.light, dark: { ...next.dark, enabled: theme.dark.enabled }, wordmark });
	}

	function update(key) {
		return (next) => onChange({ ...theme, [key]: next });
	}

	function updateColor(mode, key) {
		return (next) => onChange({ ...theme, [mode]: { ...theme[mode], [key]: next } });
	}

	return (
		<div className="flex flex-col divide-y divide-border/60">
			<Field
				label="Look"
				hint={
					isInherited
						? inherit.hint ?? `The newsletter's look${look && look.id !== "default" ? `: ${look.label}` : ""}. Pick another for this one only, or change a colour below.`
						: look?.note
				}
			>
				<span className="flex flex-wrap gap-2">
					{inherit && (
						<Button
							type="button"
							size="sm"
							variant={isInherited ? "default" : "outline"}
							aria-pressed={isInherited}
							onClick={() => onChange(null)}
						>
							{inherit.label}
						</Button>
					)}
					{THEME_LOOKS.map((item) => {
						const isPressed = !isInherited && theme.preset === item.id;
						return (
							<Button
								key={item.id}
								type="button"
								size="sm"
								variant={isPressed ? "default" : "outline"}
								aria-pressed={isPressed}
								onClick={() => chooseLook(item.id)}
							>
								{item.label}
							</Button>
						);
					})}
				</span>
			</Field>
			{theme.preset === "maiteam" && (
				<Field label="Sent by" hint={THEME_PRODUCT_OPTIONS.find((item) => item.id === theme.product)?.note}>
					<span className="flex flex-wrap gap-2">
						{THEME_PRODUCT_OPTIONS.map((item) => {
							const isPressed = !isInherited && theme.product === item.id;
							return (
								<Button
									key={item.id}
									type="button"
									size="sm"
									variant={isPressed ? "default" : "outline"}
									aria-pressed={isPressed}
									onClick={() => chooseProduct(item.id)}
								>
									{item.label}
								</Button>
							);
						})}
					</span>
				</Field>
			)}
			<Field
				label="Type"
				hint={`Fonts every mail app already has, nothing to download: ${fontNote(theme.headingFont)} for headlines, ${fontNote(theme.bodyFont)} for the text.`}
			>
				<span className="grid gap-2 sm:grid-cols-2">
					<FontSelect value={theme.headingFont} onValueChange={update("headingFont")} label="Headline font" caption="Headlines" />
					<FontSelect value={theme.bodyFont} onValueChange={update("bodyFont")} label="Text font" caption="Text" />
				</span>
			</Field>
			<Field label="Colours">
				<ColorFields mode="light" colors={theme.light} onChange={updateColor} />
			</Field>
			<Field
				label="Dark mode"
				hint="For Apple Mail, iOS Gmail, Outlook and other clients that follow the reader's setting. Off keeps the light colours everywhere."
			>
				<span className="flex flex-col gap-3">
					<span className="flex items-center sm:pt-2">
						<Switch
							checked={theme.dark.enabled}
							onCheckedChange={(enabled) => onChange({ ...theme, dark: { ...theme.dark, enabled } })}
							aria-label="Dark mode colours"
						/>
					</span>
					{theme.dark.enabled && <ColorFields mode="dark" colors={theme.dark} onChange={updateColor} />}
				</span>
			</Field>
			{problems.length > 0 && (
				<p
					role="status"
					className="flex items-start gap-2 px-4 py-3 text-xs text-pretty text-amber-700 dark:text-amber-400"
				>
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
					<span>
						Hard to read, under WCAG AA (4.5:1):{" "}
						{problems.map((problem) => `${problem.mode} ${problem.name} ${problem.ratio.toFixed(1)}:1`).join(", ")}.
					</span>
				</p>
			)}
			{compact && (
				<button
					type="button"
					aria-expanded={isMoreOpen}
					onClick={() => setIsMoreOpen((open) => !open)}
					className="flex h-10 items-center gap-1.5 px-4 text-sm text-muted-foreground hover:text-foreground"
				>
					<ChevronDown className={cn("size-3.5 transition-transform duration-150", isMoreOpen && "rotate-180")} />
					Layout and wordmark
				</button>
			)}
			{isMoreOpen && (
				<>
					<Field label="Layout">
						<ThemeSelect value={theme.layout} onValueChange={update("layout")} label="Layout">
							<SelectItem value="plain">Text on the page</SelectItem>
							<SelectItem value="card">A card on the page</SelectItem>
						</ThemeSelect>
					</Field>
					<Field label="Wordmark" hint="Set in type at the top of every email. Empty shows none.">
						<Input
							value={theme.wordmark}
							maxLength={MAX_WORDMARK_LENGTH}
							placeholder={newsletterName || "Your name"}
							aria-label="Wordmark"
							onChange={(event) => update("wordmark")(event.target.value)}
						/>
					</Field>
					<Field label="Headline" hint="Shows the subject as the email's headline.">
						<span className="flex items-center sm:pt-2">
							<Switch
								checked={theme.titleFromSubject}
								onCheckedChange={update("titleFromSubject")}
								aria-label="Show the subject as a headline"
							/>
						</span>
					</Field>
					<Field label="Footer">
						<ThemeSelect value={theme.footerTone} onValueChange={update("footerTone")} label="Footer tone">
							<SelectItem value="quiet">Quiet grey</SelectItem>
							<SelectItem value="plain">Same as the text</SelectItem>
						</ThemeSelect>
					</Field>
				</>
			)}
			{children}
		</div>
	);
}

// The light/dark switch above a preview of a look with dark colours.
export function SchemeToggle({ value, onChange }) {
	return (
		<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
			{SCHEMES.map(({ id, label, icon: Icon }) => (
				<button
					key={id}
					type="button"
					aria-label={label}
					aria-pressed={value === id}
					onClick={() => onChange(id)}
					className={cn(
						"relative grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground",
						value === id && "bg-background text-foreground shadow-border"
					)}
				>
					<Icon className="size-3.5" />
				</button>
			))}
		</div>
	);
}

// One line naming a document's look, for the collapsed row in the editors.
export function describeLook(value, inherit) {
	if (!value && inherit) {
		const base = THEME_LOOKS.find((item) => item.id === (inherit.theme?.preset ?? "default"));
		return `${inherit.label}${base && base.id !== "default" ? ` · ${base.label}` : ""}`;
	}
	const full = completeTheme(value);
	const base = THEME_LOOKS.find((item) => item.id === full.preset);
	const preset = presetTheme(full.preset, full.product);
	const product = full.product && full.product !== "company" ? ` · ${full.product}` : "";
	const isEdited =
		THEME_COLOR_KEYS.some((key) => full.light[key] !== preset.light[key]) ||
		full.headingFont !== preset.headingFont ||
		full.bodyFont !== preset.bodyFont;
	return `${inherit ? "This one only · " : ""}${base?.label ?? "Default"}${product}${isEdited ? ", edited" : ""}`;
}

function fontNote(id) {
	return THEME_FONT_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

// One of the email-safe fonts, named in itself so the list shows what each looks like.
function FontSelect({ value, onValueChange, label, caption }) {
	return (
		<span className="flex flex-col gap-1">
			<Select value={value} onValueChange={onValueChange}>
				<SelectTrigger className="h-9 w-full" aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{THEME_FONT_OPTIONS.map((option) => (
						<SelectItem key={option.id} value={option.id} style={{ fontFamily: FONT_STACKS[option.id] }}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<span className="text-xs text-muted-foreground">{caption}</span>
		</span>
	);
}

function ThemeSelect({ value, onValueChange, label, children }) {
	return (
		<Select value={value} onValueChange={onValueChange}>
			<SelectTrigger className="h-9 w-full sm:w-56" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>{children}</SelectContent>
		</Select>
	);
}

// A swatch and the hex it stands for; the hex is what gets saved, so a half-typed value is checked on
// save rather than snapped to black here.
function ColorFields({ mode, colors, onChange }) {
	return (
		<span className="grid gap-2 sm:grid-cols-2">
			{THEME_COLOR_KEYS.map((key) => {
				const value = colors[key] ?? "";
				return (
					<span key={key} className="flex items-center gap-2">
						<input
							type="color"
							value={HEX_COLOR_PATTERN.test(value) ? value : "#000000"}
							onChange={(event) => onChange(mode, key)(event.target.value)}
							aria-label={`${mode} ${COLOR_LABELS[key]} colour`}
							className="size-8 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
						/>
						<Input
							value={value}
							onChange={(event) => onChange(mode, key)(event.target.value.toLowerCase())}
							aria-label={`${mode} ${COLOR_LABELS[key]} hex`}
							className="h-8 w-24 font-mono text-xs"
						/>
						<span className="text-xs text-muted-foreground">{COLOR_LABELS[key]}</span>
					</span>
				);
			})}
		</span>
	);
}

function Field({ label, hint, children }) {
	return (
		<label className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<span className="text-sm text-muted-foreground sm:pt-2">{label}</span>
			<span className="flex flex-col gap-1.5">
				{children}
				{hint && <span className="text-xs text-pretty text-muted-foreground">{hint}</span>}
			</span>
		</label>
	);
}
