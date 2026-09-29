/**
 * Well-known credential formats (API keys, access tokens, JWTs).
 *
 * [Session Goal] and [User Preferences] are rebuilt from every user entry at
 * each compaction, so a line placed there stays in the model context for the
 * rest of the session. A line carrying a credential is never promoted to those
 * sections; it remains in the raw session (recallable) and may appear in the
 * transient brief like any other text.
 */
const SECRET_TOKEN_RE =
	/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

export const hasSecretToken = (text: string): boolean => SECRET_TOKEN_RE.test(text);
