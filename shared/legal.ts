/**
 * Canonical legal-document identity for the dashboard (`src/`): the paths the
 * settings legal row links to, and the version and digests of the legal pages.
 *
 * Pure data — no DOM, no Node imports.
 *
 * TERMS_VERSION is the "Last updated" date the legal documents carry, in ISO
 * form. Git history is the archive, and the digests below make an unbumped
 * edit fail loudly. `tests/legal-version.test.mts` holds the three together —
 * the constant, the date on each page, and the body digest.
 */

/**
 * ISO date of the current legal documents. The EULA, the Terms and the DPA
 * carry ONE date — `tests/legal-version.test.mts` enforces that they agree.
 * The privacy policy was removed for the personal setup; what a public launch
 * would have to disclose is in docs/internal/public-launch-disclosures.md.
 */
export const TERMS_VERSION = '2026-11-02';

/** The licence itself: what each plan grants, on every surface (#6983). */
export const EULA_PATH = '/docs/eula';
export const TERMS_PATH = '/docs/terms';
/** Data Processing Addendum — entered separately by customers who need one. */
export const DPA_PATH = '/docs/dpa';
export const LICENSE_PATH = '/docs/license';
export const TRADEMARK_PATH = '/docs/trademark-policy';

/**
 * The legal cluster every footer carries. A browsewrap ("by using the Service
 * you agree…") is only as enforceable as the link it depends on, and #6976
 * found that link missing from both production footers and the dashboard.
 *
 * The EULA leads: it is the instrument that states what a plan grants and what
 * it forbids. "Source license" rather than "License" for the AGPL page, because
 * two entries reading "License …" side by side is exactly the ambiguity the
 * split between code licence and service licence needs to avoid.
 */
export const LEGAL_FOOTER_LINKS: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'License agreement', path: EULA_PATH },
  { label: 'Terms', path: TERMS_PATH },
  { label: 'Source license', path: LICENSE_PATH },
  { label: 'Trademark', path: TRADEMARK_PATH },
];

/**
 * Every published legal document, with the SHA-256 of its normalized body.
 *
 * All three share one version, so a holder of a countersigned copy can tell
 * which text it matches.
 *
 * This is what replaces dated archive pages (owner decision, 2026-08-20: git
 * history is the archive). A history link alone cannot catch the failure that
 * matters — a body edited without bumping the date, which silently remaps every
 * existing acceptance onto text nobody agreed to. The digest catches it: edit
 * the body, and `tests/legal-version.test.mts` fails until the version is
 * bumped and the digest regenerated with `npm run legal:digests`.
 *
 * Normalized = frontmatter and MDX review comments stripped, trailing
 * whitespace collapsed, so editorial notes do not force a version bump.
 */
export const LEGAL_DOCUMENT_DIGESTS: Readonly<Record<string, string>> = {
  'docs/eula.mdx': '3a37cd27304f3f2aea543c869e7a9a7a25900a2a0a68213328d0201ee7d0aa14',
  'docs/terms.mdx': '8666aa8197a363f2683683304a958ca05c589c686b6641d04b73472cf72e8c73',
  'docs/dpa.mdx': '6012fc1be1af02479e660adfa278981709023586706b61f17044072881dbb543',
};

/** Where the text behind any recorded version can be read back. */
export function legalHistoryUrl(docPath: string): string {
  return `https://github.com/koala73/worldmonitor/commits/main/${docPath}`;
}

/** Absolute form of a legal path against the docs origin. */
export function absoluteLegalUrl(path: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}
