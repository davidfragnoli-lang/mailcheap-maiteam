"use client";

import { useEffect, useState } from "react";
import { startSignup } from "@/app/archive/actions";

// maiteam (P5, PATCHES.md): the archive form's side of lib/maiteam/signup-protection.js: the signed fill stamp and the
// choice after a typo suggestion. The Turnstile widget is components/maiteam/FieldsSignupProtection.jsx.

export function useSignupProtection(state, formRef) {
	const [email, setEmail] = useState("");
	const [stamp, setStamp] = useState("");
	const [keepAsTyped, setKeepAsTyped] = useState("");

	useEffect(() => {
		startSignup().then(({ stamp }) => setStamp(stamp ?? ""), () => {});
	}, []);

	useEffect(() => {
		if (state?.restart) startSignup().then(({ stamp }) => setStamp(stamp ?? ""), () => {});
	}, [state]);

	// The person picks: the suggested address, or theirs as typed. Neither happens without a click.
	function resubmit({ address, keep }) {
		setEmail(address);
		setKeepAsTyped(keep ? address : "");
		requestAnimationFrame(() => formRef.current?.requestSubmit());
	}

	return {
		email,
		stamp,
		keepAsTyped,
		onEmailChange(event) {
			setEmail(event.target.value);
			setKeepAsTyped("");
		},
		// Only while the address that got it is still in the field.
		suggestion: state?.suggestion && state.typed === email.trim().toLowerCase() ? { address: state.suggestion, typed: state.typed } : null,
		resubmit,
	};
}
