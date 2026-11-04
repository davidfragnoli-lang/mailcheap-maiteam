"use client";

import { useEffect, useLayoutEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronsUpDown, Loader2, Plus, Settings } from "lucide-react";
import { selectNewsletter } from "@/app/(app)/newsletters/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGE_LABELS, familyLanguageKey, pickFamilyMember, sortFamily } from "@/lib/maiteam/newsletter-families";
import { ADD_NEWSLETTER_PARAM, MAX_NEWSLETTERS_PER_ACCOUNT, NEWSLETTER_COOKIE, NEWSLETTER_LIMIT_MESSAGE } from "@/lib/newsletters";
import { readCookie, storeValue } from "@/lib/storage";
import { ROLE_LABELS } from "@/lib/team-rules";
import { toast } from "@/lib/toast";
import { useHasRole } from "@/lib/use-team-role";
import { cn } from "@/lib/utils";

// The sidebar and the phone's top bar each have this menu: one refresh does for both.
let refreshedFor = null;

// The newsletter the dashboard shows, and the others to switch to. savedId: the cookie the layout was rendered from.
// addForm: FormAddNewsletter, for Add a newsletter's dialog.
// maxNewsletters, limitMessage: the server's own (PATCHES.md P13), upstream's by default.
// newsletters[].family (PATCHES.md P16): the lists of one newsletter in several languages show as one row, named without
// the language, and the open one has a language selector; null for a list on its own, which shows as before.
export default function MenuNewsletter({
	newsletters,
	selectedId,
	savedId,
	isCompact = false,
	addForm,
	maxNewsletters = MAX_NEWSLETTERS_PER_ACCOUNT,
	limitMessage = NEWSLETTER_LIMIT_MESSAGE,
}) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [isPending, startTransition] = useTransition();
	const [shownId, setShownId] = useState(selectedId);
	const [renderedId, setRenderedId] = useState(selectedId);
	const [isAdding, setIsAdding] = useState(false);
	const hasSettings = useHasRole("admin");
	if (selectedId !== renderedId) {
		setRenderedId(selectedId);
		setShownId(selectedId);
		setIsAdding(false);
	}
	const shown = newsletters.find(({ id }) => id === shownId) ?? newsletters[0];
	const siblings = shown?.family ? sortFamily(newsletters.filter(({ family }) => family?.key === shown.family.key)) : [];
	// Links to Add a newsletter open the sidebar's dialog: that menu is on the page at every width, only hidden on
	// phones, and the dialog shows over the page from a portal.
	const isLinked = !isCompact && searchParams.has(ADD_NEWSLETTER_PARAM);

	// Pages follow the cookie, and this layout doesn't render again on navigation: a link to another newsletter's
	// campaign, or a switch in another tab, changes the cookie under it. The menu then shows the newsletter the page
	// shows before it paints, and refreshes once to catch up.
	useLayoutEffect(() => {
		function check() {
			const cookie = readCookie(NEWSLETTER_COOKIE);
			if (!cookie || cookie === savedId) return;
			if (newsletters.some(({ id }) => id === cookie)) setShownId(cookie);
			const key = `${savedId}>${cookie}`;
			if (refreshedFor === key) return;
			refreshedFor = key;
			router.refresh();
		}
		check();
		window.addEventListener("focus", check);
		return () => window.removeEventListener("focus", check);
	}, [pathname, savedId, newsletters, router]);

	// A language's row opens the language last opened in it (pickFamilyMember).
	const shownLanguage = shown?.family?.language;
	const shownFamily = shown?.family?.key;
	useEffect(() => {
		if (shownFamily) storeValue(familyLanguageKey(shownFamily), shownLanguage);
	}, [shownFamily, shownLanguage]);

	function setAdding(isOpen) {
		setIsAdding(isOpen);
		if (isOpen || !isLinked) return;
		const params = new URLSearchParams(searchParams);
		params.delete(ADD_NEWSLETTER_PARAM);
		const query = params.toString();
		window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
	}

	const dialog = (
		<Dialog open={isAdding || isLinked} onOpenChange={setAdding}>
			<DialogContent className="sm:max-w-md">{addForm}</DialogContent>
		</Dialog>
	);

	if (!shown) {
		return (
			<>
				<button type="button" onClick={() => setAdding(true)} className={cn(TRIGGER, isCompact ? TRIGGER_COMPACT : TRIGGER_FULL, "text-muted-foreground")}>
					<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted">
						<Plus className="size-3.5" />
					</span>
					<span className="truncate text-sm font-medium sidebar-label">Add a newsletter</span>
				</button>
				{dialog}
			</>
		);
	}

	function select(id) {
		if (id === shownId) return;
		setShownId(id);
		startTransition(async () => {
			const result = await selectNewsletter(id, pathname);
			if (!result?.error) return;
			setShownId(selectedId);
			toast.error(result.error);
		});
	}

	// A family's row has its own value; choosing it opens one of its lists.
	function choose(value) {
		const family = value.startsWith(FAMILY_VALUE) ? value.slice(FAMILY_VALUE.length) : null;
		if (!family) return select(value);
		if (shown.family?.key === family) return;
		const member = pickFamilyMember(
			newsletters.filter((newsletter) => newsletter.family?.key === family),
			readStoredText(familyLanguageKey(family)),
		);
		if (member) select(member.id);
	}

	// The cap counts lists, not rows.
	const ownCount = newsletters.filter(({ role }) => !role).length;
	const own = toRows(newsletters.filter(({ role }) => !role));
	const shared = toRows(newsletters.filter(({ role }) => role));
	const value = shown.family ? FAMILY_VALUE + shown.family.key : shownId;
	const shownName = shown.family?.name ?? shown.name;
	const shownLabel = shown.family ? `${shownName}, ${LANGUAGE_LABELS[shown.family.language]}` : shownName;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button type="button" aria-label={`Newsletter: ${shownLabel}`} className={cn(TRIGGER, isCompact ? TRIGGER_COMPACT : TRIGGER_FULL)}>
						<AvatarNewsletter newsletter={shown} size={24} />
						<span className="min-w-0 flex-1 truncate text-left text-sm font-medium sidebar-label">{shownName}</span>
						<span className="relative grid size-4 shrink-0 place-items-center text-muted-foreground sidebar-label">
							<ChevronsUpDown className={cn("absolute size-4", ICON_MOTION, isPending ? ICON_HIDDEN : ICON_SHOWN)} />
							<Loader2 className={cn("absolute size-4 animate-spin", ICON_MOTION, isPending ? ICON_SHOWN : ICON_HIDDEN)} />
						</span>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" sideOffset={6} className={cn("p-1.5", isCompact ? "w-64" : "min-w-60")}>
					{own.length > 0 && (
						<>
							<DropdownMenuLabel className="px-2 pt-1 pb-1.5">Newsletters</DropdownMenuLabel>
							<DropdownMenuRadioGroup value={value} onValueChange={choose}>
								{own.map((row) => (
									<ItemNewsletter key={row.value} row={row} />
								))}
							</DropdownMenuRadioGroup>
						</>
					)}
					{shared.length > 0 && (
						<>
							{own.length > 0 && <DropdownMenuSeparator className="my-1.5" />}
							<DropdownMenuLabel className="px-2 pt-1 pb-1.5">Shared with you</DropdownMenuLabel>
							<DropdownMenuRadioGroup value={value} onValueChange={choose}>
								{shared.map((row) => (
									<ItemNewsletter key={row.value} row={row} />
								))}
							</DropdownMenuRadioGroup>
						</>
					)}
					<DropdownMenuSeparator className="my-1.5" />
					{ownCount < maxNewsletters ? (
						<DropdownMenuItem className={ITEM} onSelect={() => setAdding(true)}>
							<Plus />
							Add a newsletter
						</DropdownMenuItem>
					) : (
						<div className="px-2 py-1.5">
							<DropdownMenuItem disabled className="h-auto gap-2.5 p-0 text-muted-foreground">
								<Plus />
								Add a newsletter
							</DropdownMenuItem>
							<p className="mt-1 text-xs text-pretty text-muted-foreground">{limitMessage}</p>
						</div>
					)}
					{hasSettings && (
						<DropdownMenuItem asChild className={ITEM}>
							<Link href="/newsletters">
								<Settings />
								Newsletter settings
							</Link>
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{siblings.length > 1 && <SwitcherLanguage siblings={siblings} shown={shown} name={shownName} isCompact={isCompact} onSelect={select} />}
			{dialog}
		</>
	);
}

const FAMILY_VALUE = "family:";

// One row per list, and one per family where its first list is, in the menu's order. A family's row shows its English
// list's picture, else its first's.
function toRows(newsletters) {
	const rows = [];
	const seen = new Set();
	for (const newsletter of newsletters) {
		if (!newsletter.family) {
			rows.push({ value: newsletter.id, name: newsletter.name, newsletter, role: newsletter.role });
			continue;
		}
		const { key, name } = newsletter.family;
		if (seen.has(key)) continue;
		seen.add(key);
		const members = sortFamily(newsletters.filter(({ family }) => family?.key === key));
		const face = members.find(({ family }) => family.language === "en") ?? members[0];
		rows.push({ value: FAMILY_VALUE + key, name, newsletter: face, role: newsletter.role, languages: members.length });
	}
	return rows;
}

function readStoredText(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

// A shared newsletter shows the user's role on it; a family, how many languages it has.
function ItemNewsletter({ row }) {
	const note = row.role ? ROLE_LABELS[row.role] : row.languages ? `${row.languages} languages` : null;
	return (
		<DropdownMenuRadioItem value={row.value} className="h-9 gap-2.5 rounded-lg pl-2">
			<AvatarNewsletter newsletter={row.newsletter} size={20} />
			<span className="truncate">{row.name}</span>
			{note && <span className="ml-auto shrink-0 pr-5 text-xs text-muted-foreground">{note}</span>}
		</DropdownMenuRadioItem>
	);
}

// The open newsletter's languages, EN FR IT DE ES. Switching opens the other list on the same page (switchNewsletter).
// The sidebar shows them all as a row under the menu; the phone's top bar, as a small menu beside it.
function SwitcherLanguage({ siblings, shown, name, isCompact, onSelect }) {
	const code = shown.family.language.toUpperCase();
	if (isCompact) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label={`Language: ${code}, ${LANGUAGE_LABELS[shown.family.language]}`}
						className="ml-0.5 flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
					>
						{code}
						<ChevronDown className="size-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={6} className="min-w-40 p-1.5">
					<DropdownMenuLabel className="px-2 pt-1 pb-1.5">{name} language</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={shown.id} onValueChange={onSelect}>
						{siblings.map(({ id, family }) => (
							<DropdownMenuRadioItem key={id} value={id} className="h-9 gap-2.5 rounded-lg pl-2">
								<span className="w-6 text-xs font-medium">{family.language.toUpperCase()}</span>
								<span className="text-muted-foreground">{LANGUAGE_LABELS[family.language]}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}
	return (
		<div role="group" aria-label={`${name} language`} className="mt-2 flex gap-1 sidebar-label sidebar-folded:invisible">
			{siblings.map(({ id, family }) => {
				const isShown = id === shown.id;
				return (
					<button
						key={id}
						type="button"
						aria-pressed={isShown}
						title={LANGUAGE_LABELS[family.language]}
						onClick={() => onSelect(id)}
						className={cn(
							"h-7 min-w-0 flex-1 rounded-md text-xs font-medium outline-none transition-[background-color,box-shadow,color] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
							isShown ? "bg-card text-foreground shadow-border" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
						)}
					>
						{family.language.toUpperCase()}
						<span className="sr-only"> {LANGUAGE_LABELS[family.language]}</span>
					</button>
				);
			})}
		</div>
	);
}

const TRIGGER =
	"flex min-w-0 items-center gap-2.5 outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50";
// The folded sidebar only shows the avatar, where it was: the rest is cut at the edge as it fades.
const TRIGGER_FULL =
	"h-11 w-full overflow-hidden rounded-xl bg-card pr-3 pl-2.5 shadow-border hover:bg-muted/50 hover:shadow-border-hover data-[state=open]:bg-muted/60";
const TRIGGER_COMPACT = "h-10 max-w-full rounded-lg pr-2 pl-1.5 hover:bg-muted data-[state=open]:bg-muted";
const ITEM = "h-9 gap-2.5 rounded-lg px-2 text-muted-foreground focus:text-foreground [&_svg]:text-muted-foreground";
// Both icons stay in place, so the spinner and the chevrons cross-fade instead of jumping.
const ICON_MOTION = "transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
const ICON_SHOWN = "scale-100 opacity-100 blur-[0px]";
const ICON_HIDDEN = "scale-25 opacity-0 blur-[4px]";
