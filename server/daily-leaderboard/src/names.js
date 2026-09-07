/**
 * Display-name rules for the Daily Conquest leaderboard.
 *
 * Deliberately server-side and independent of the client's `normalizeName`:
 * the board is public and the client is not trusted, so this is the rule that
 * decides what appears on it. The client's copy exists to give instant feedback,
 * not to gate anything.
 *
 * @module server/daily-leaderboard/names
 */

/** Longest accepted display name, in code points. */
export const NAME_MAX_LENGTH = 16;

/**
 * Characters a name may contain after normalization: letters and digits in any
 * script (so non-Latin names work), plus space, hyphen and underscore.
 *
 * Everything else is out — notably control characters, bidi overrides, and the
 * markup/emoji that would let one entry hijack the look of the whole board.
 *
 * This is deliberately the SAME set as the client's `NAME_PATTERN` in
 * `src/game/dailyLeaderboard.js`, and the {@link IGNORABLE}/{@link VISIBLE}
 * rules below are mirrored there too. The two copies exist for different
 * reasons — the client's is instant feedback, this one is the only one that
 * decides anything — but a name the client accepted must never come back 400,
 * so this set may be widened independently and must never be narrowed.
 */
const ALLOWED = /^[\p{L}\p{N} _-]+$/u;

/**
 * Code points that may not appear in a name at all, stripped here only so the
 * "did it contain one?" test is a comparison rather than a stateful `/g` match.
 *
 * `\p{Default_Ignorable_Code_Point}` is the rule; the four Hangul fillers
 * (U+115F, U+1160, U+3164, U+FFA0) are spelled out beside it because they are
 * the reason it exists. They are `\p{L}`, they survive NFC, and they render as
 * nothing — so `ㅤ` alone passes {@link ALLOWED} as a blank, unclaimable board
 * entry, and sprinkled through a word they hide it from {@link squash}. Naming
 * them explicitly also keeps the rule true on an engine whose Unicode data lags.
 */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0]/gu;

/** A name has to show something: at least one letter or digit that renders. */
const VISIBLE = /[\p{L}\p{N}]/u;

/**
 * Names nobody gets to claim. Two rules, because they fail differently:
 * `RESERVED` are impersonation risks and are matched whole, so a real name that
 * merely contains one is fine; `BLOCKED` are slurs and profanity and are matched
 * as substrings of the squashed form, because that is how they get smuggled in.
 *
 * This is a small, honest speed bump, not moderation. The owner is expected to
 * delete rows by hand when something gets through — see the README.
 */
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'dicewars']);

const BLOCKED = ['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'rape'];

/**
 * Squash a name to the form the blocklist is checked against: lower-cased, with
 * the usual leet substitutions folded back and every separator removed, so
 * `f_u_c_k` and `f4ck` are caught alongside `fuck`.
 *
 * @param {string} name
 * @returns {string}
 */
function squash(name) {
  return name
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1|!]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
}

/**
 * Normalize a submitted display name, or reject it.
 *
 * Trims, collapses internal whitespace runs to a single space, and enforces the
 * length and charset rules. Returns `null` for anything that fails — the caller
 * turns that into `name_rejected`; there is no partial acceptance, because a
 * silently altered name is worse than a refused one.
 *
 * @param {unknown} raw
 * @returns {string|null} The name to store, or null if it is not usable
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  /*
   * Unicode-normalize first so a name that is only combining marks, or that is
   * long only in its decomposed form, is measured the way it will be displayed.
   */
  const collapsed = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  // Code points, not UTF-16 units: a 16-emoji-free name should not be rejected
  // because some of its letters live outside the BMP.
  if ([...collapsed].length > NAME_MAX_LENGTH) return null;
  if (!ALLOWED.test(collapsed)) return null;
  /*
   * Invisibles are refused rather than stripped: a name that only LOOKS like
   * the one the player typed is exactly the confusion the board must not carry.
   * Then require something visible, which also turns away `-`, `_` and `___`.
   */
  const visible = collapsed.replace(IGNORABLE, '');
  if (visible !== collapsed) return null;
  if (!VISIBLE.test(visible)) return null;
  if (isBlockedName(collapsed)) return null;
  return collapsed;
}

/**
 * Is this (already normalized) name off limits?
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isBlockedName(name) {
  const squashed = squash(name);
  if (squashed.length === 0) return false; // digits/punctuation only — allowed
  if (RESERVED.has(squashed)) return true;
  return BLOCKED.some(word => squashed.includes(word));
}
