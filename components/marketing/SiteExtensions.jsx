// maiteam (PATCHES.md P10): this server's site extensions. next.config.mjs resolves @/components/SiteExtensions here
// because this file exists; everything else stays the open source's default (null), only WhatsNew is filled.
export * from "../SiteExtensions.jsx";
export { default as WhatsNew } from "../maiteam/WhatsNew.jsx";
