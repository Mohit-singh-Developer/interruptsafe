/**
 * Splits an assistant reply into speakable clauses.
 *
 * ## Why chunk at all
 *
 * Synthesising a whole reply before playing any of it means the user waits for
 * the slowest possible unit. Synthesising clause by clause means speech can
 * start after the *first* clause is ready, and the rest is fetched while the
 * first is playing.
 *
 * It also makes interruption finer-grained. Each clause is an independently
 * generation-stamped playback unit, so an interruption discards at clause
 * granularity instead of leaving a whole paragraph queued.
 *
 * ## Why it is done here rather than server-side
 *
 * Rime's HTTP synthesis endpoint returns one clip per request, so chunking is
 * simply "make several requests". Doing that from the client keeps each request
 * independently abortable and avoids inventing a multi-clip response format.
 * No undocumented streaming protocol is involved.
 */

/**
 * Target upper bound per clause, in characters.
 *
 * Short enough that the first clause returns quickly, long enough that speech
 * does not sound chopped into fragments.
 */
const MAX_CLAUSE_CHARS = 150;

/** Below this, a trailing fragment is merged backwards instead of standing alone. */
const MIN_CLAUSE_CHARS = 24;

/** Splits on sentence enders and newlines, keeping the punctuation. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Hard-splits a sentence that is too long, preferring commas then spaces. */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_CLAUSE_CHARS) return [sentence];

  const pieces: string[] = [];
  let remaining = sentence;

  while (remaining.length > MAX_CLAUSE_CHARS) {
    const window = remaining.slice(0, MAX_CLAUSE_CHARS);
    const atComma = window.lastIndexOf(", ");
    const atSpace = window.lastIndexOf(" ");
    const cut = atComma > MIN_CLAUSE_CHARS ? atComma + 1 : atSpace > 0 ? atSpace : MAX_CLAUSE_CHARS;

    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/**
 * Returns the clauses to synthesise, in order.
 *
 * An empty or whitespace-only input yields an empty list, so callers never
 * issue a synthesis request for nothing.
 */
export function splitIntoClauses(text: string): string[] {
  const sentences = splitSentences(text);
  const clauses: string[] = [];

  for (const sentence of sentences) {
    for (const piece of splitLongSentence(sentence)) {
      const previous = clauses.at(-1);

      // Merge a very short *fragment* into the previous clause rather than
      // sending a request that synthesises two words.
      //
      // Only mid-sentence fragments qualify. A previous clause that already
      // ends in sentence punctuation is complete, and merging onto it would
      // undo the chunking entirely for replies made of short sentences -
      // which is exactly the shape a concise voice agent produces.
      const previousIsComplete = previous !== undefined && /[.!?]$/.test(previous);

      if (
        previous !== undefined &&
        !previousIsComplete &&
        piece.length < MIN_CLAUSE_CHARS &&
        previous.length + piece.length + 1 <= MAX_CLAUSE_CHARS
      ) {
        clauses[clauses.length - 1] = `${previous} ${piece}`;
        continue;
      }

      clauses.push(piece);
    }
  }

  return clauses;
}
