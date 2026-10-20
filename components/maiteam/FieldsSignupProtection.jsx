"use client";

import { useEffect, useRef } from "react";

// maiteam (P5, PATCHES.md): the archive form's hidden fields, the Turnstile widget, and the choice after a typo
// suggestion. `protection` comes from useSignupProtection (lib/maiteam/use-signup-protection.js).

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
// Must match TURNSTILE_ACTION in lib/maiteam/signup-protection.js.
const TURNSTILE_ACTION = "archive-signup";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

function loadTurnstile() {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	window.__turnstileLoad ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = TURNSTILE_SCRIPT;
		script.async = true;
		script.onload = () => resolve(window.turnstile);
		script.onerror = reject;
		document.head.append(script);
	});
	return window.__turnstileLoad;
}

// Cloudflare's check runs in the background and only asks for a click when it's unsure. Its token lands in a hidden
// "cf-turnstile-response" input inside the form.
function useTurnstile(containerRef) {
	const widgetId = useRef(null);
	useEffect(() => {
		if (!SITE_KEY) return;
		let cancelled = false;
		loadTurnstile()
			.then((turnstile) => {
				if (cancelled || !containerRef.current || widgetId.current !== null) return;
				widgetId.current = turnstile.render(containerRef.current, {
					sitekey: SITE_KEY,
					action: TURNSTILE_ACTION,
					appearance: "interaction-only",
					size: "flexible",
				});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
			if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
			widgetId.current = null;
		};
	}, [containerRef]);
	// A token is spent once the server has checked it.
	return () => {
		if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
	};
}

export default function FieldsSignupProtection({ state, protection }) {
	const { suggestion, resubmit } = protection;
	const widgetRef = useRef(null);
	const resetTurnstile = useTurnstile(widgetRef);

	useEffect(() => {
		// A suggestion is answered before the token is checked, so it stays usable for the next click.
		if (state?.error && !state.suggestion) resetTurnstile();
		// resetTurnstile only reads a ref.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state]);

	return (
		<>
			<input type="hidden" name="started" value={protection.stamp} />
			<input type="hidden" name="keepAsTyped" value={protection.keepAsTyped} />
			<div ref={widgetRef} className="mt-2 empty:hidden" />
			{suggestion && (
				<div role="alert" className="mt-2 text-sm">
					<p>
						Did you mean <strong className="font-semibold break-words">{suggestion.address}</strong>?
					</p>
					<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
						<button
							type="button"
							className="font-medium underline underline-offset-4"
							onClick={() => resubmit({ address: suggestion.address, keep: false })}
						>
							Use {suggestion.address}
						</button>
						<button
							type="button"
							className="text-muted-foreground underline underline-offset-4"
							onClick={() => resubmit({ address: suggestion.typed, keep: true })}
						>
							Keep {suggestion.typed}
						</button>
					</div>
				</div>
			)}
		</>
	);
}
