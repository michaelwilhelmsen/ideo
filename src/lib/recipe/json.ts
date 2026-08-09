/**
 * The two guards every loader in this folder starts with.
 *
 * Internal to `lib/recipe` and deliberately not re-exported from `index.ts`:
 * this is plumbing for the parsers, not vocabulary for the app.
 *
 * They were written out three times — once each in `presets.ts`, `motion.ts`
 * and `manifest.ts` — which is three places for the array case to be forgotten.
 * That case is the whole point: `typeof [] === 'object'`, so a document that is
 * a JSON array would otherwise pass a naive record check and then read every
 * field back as `undefined`, turning a malformed file into a silently empty one
 * instead of a loud refusal.
 */

/** A JSON object — not `null`, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The same check as a refusal, for the top of a parser.
 *
 * `what` names the document rather than the field, because at the point this
 * throws nothing has been read yet — "Malformed motion preset library" is all
 * there is to say, and it is more than "Cannot read properties of undefined"
 * three frames later. `manifest.ts` keeps its own wording for the same idea: its
 * refusals name a *field*, and read as one family with `asArray` and `asString`.
 */
export function asRecord(
  value: unknown,
  what: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Malformed ${what}`)
  return value
}
