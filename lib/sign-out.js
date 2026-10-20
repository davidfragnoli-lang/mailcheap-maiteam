// Fired on the window once someone agrees to sign out, so the support chat (SupportChat in
// components/SiteExtensions.jsx) forgets their conversation before anyone else signs in on this browser.
export const SIGN_OUT_EVENT = "mailcheap:sign-out";

// Every way to sign out asks first: the buttons (ButtonSignout) and the account menu (MenuUser).
export function askToSignOut() {
	if (!window.confirm("Sign out of mailcheap?")) return false;
	window.dispatchEvent(new Event(SIGN_OUT_EVENT));
	return true;
}
