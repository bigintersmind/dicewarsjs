/**
 * The wire version of a daily leaderboard submission.
 *
 * The body a client posts is `{ version, name, replay }`, and this number is
 * the `version` in it: the client stamps it, the Worker refuses anything else
 * with `invalid_body`. It lives in a module of its own so both sides can import
 * the same constant — the client's `dailyLeaderboard.js` reads `import.meta.env`
 * at module scope, which a Worker bundle must not pull in, so that file cannot
 * be the shared home for it.
 *
 * Bump it only when the envelope's SHAPE changes, and deploy the Worker before
 * (or with) the client, or every post from the new client is rejected.
 *
 * @module game/dailySubmission
 */

/** Submission envelope version spoken by this build, client and Worker alike. */
export const SUBMISSION_VERSION = 1;
