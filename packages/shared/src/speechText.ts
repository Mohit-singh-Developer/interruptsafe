/**
 * Prepares committed assistant text for speech synthesis.
 *
 * Written against Rime's official guidance:
 *   - https://docs.rime.ai/docs/prompting
 *   - https://www.rime.ai/resources/writing-for-the-ear-prompting-your-tts-to-sound-human
 *
 * Both say the same thing in different words: text written to be *read* is not
 * text written to be *heard*. Markdown, bullets, arrows and parenthetical
 * asides are visual conventions. Sent to a synthesiser they are pronounced -
 * "dash I S four eight six, Delhi hyphen greater-than Mumbai" - which is
 * exactly what our mock tool replies would have produced.
 *
 * ## Boundaries this deliberately respects
 *
 * This changes only how a reply is *spoken*. The committed transcript, the
 * conversation history the provider sees, and anything the fencing logic
 * touches are all left untouched - the displayed text and the spoken text come
 * from the same committed source, and only the latter passes through here.
 *
 * Rime **does not support SSML**: its prompting guide says plainly not to send
 * `<break>`, `<emotion>` or other inline tags. Nothing here emits markup.
 *
 * Its one documented inline function, `spell()`, is also not emitted - but for
 * a measured reason rather than an assumed one. See the note above
 * `linesToSentences`, and the A/B measurements in docs/RIME_EVIDENCE.md 4.3.
 * (Inline *phoneme* control is a separate feature, documented as Mist v2 only;
 * neither mistv3 nor coda offers it.)
 */

/** Rime's guide: keep spoken sentences under 25 words to avoid breathlessness. */
export const MAX_SPOKEN_WORDS_PER_SENTENCE = 25;

/** Rewrites symbols that are read visually but must be heard as words. */
function speakSymbols(text: string): string {
  return (
    text
      // Route arrows are common in travel output: "Delhi -> Mumbai".
      .replace(/\s*(->|→|=>)\s*/g, " to ")
      // Ranges and separators that would otherwise be read as "hyphen".
      .replace(/(\d)\s*-\s*(\d)/g, "$1 to $2")
      .replace(/&/g, " and ")
      .replace(/\s*\|\s*/g, ", ")
      // Rates. Hotel rows read "approx 3056 rupees/night", and a synthesiser
      // given a bare slash says "slash". Restricted to a known list of rate
      // units so that ordinary uses like "and/or" are left alone.
      .replace(
        /\s*\/\s*(night|day|week|month|year|hour|hr|hrs|h|person|head|km|mile|kg|litre|liter|gallon)\b/gi,
        " per $1",
      )
  );
}

/**
 * Rewrites currency Rime's normaliser does not handle.
 *
 * Its prompting guide handles dollar amounts natively but asks for non-dollar
 * currency to be written out, giving "€900K" -> "900 thousand euros".
 */
function speakCurrency(text: string): string {
  return text
    .replace(/\bINR\s*([\d,]+)/gi, "$1 rupees")
    .replace(/\bUSD\s*([\d,]+)/gi, "$1 dollars")
    .replace(/\bEUR\s*([\d,]+)/gi, "$1 euros")
    .replace(/\bGBP\s*([\d,]+)/gi, "$1 pounds");
}

/** Removes written-only formatting: markdown, bullets, code fences. */
function stripWrittenFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    // Rime's prompting guide forbids inline tags such as <break> and
    // <emotion>. Anything tag-shaped is removed defensively so a stray one can
    // never be pronounced or misinterpreted.
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    // Bullets and numbered list markers at the start of a line.
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1");
}

/**
 * Flattens a parenthetical aside into the sentence.
 *
 * "Writing for the ear" asks for these to be flattened rather than spoken as
 * bracketed interruptions. A comma keeps the pause without the visual bracket.
 */
function flattenAsides(text: string): string {
  return text.replace(/\s*\(([^)]*)\)\s*/g, (_match, inner: string) => {
    const trimmed = inner.trim();
    return trimmed.length === 0 ? " " : `, ${trimmed}, `;
  });
}

/*
 * `spell()` is deliberately NOT applied to flight codes here.
 *
 * Rime documents it as a Mist-family function, and this project ships mistv3,
 * so it should be available. An implementation was written and then removed,
 * because a live A/B could not show it doing anything: holding model and voice
 * constant and rendering both variants, the delta between "Flight IS486
 * departs." and "Flight spell(IS486) departs." did not grow with code length,
 * and for a twelve-character code the spell() clip was marginally *shorter*.
 * A processed spell() has to take longer - there are more characters to
 * enunciate. The measurements are in docs/RIME_EVIDENCE.md section 4.3.
 *
 * Shipping it anyway carried a specific risk: if Rime does not process the
 * construct, the most likely audible result is the literal word "spell" being
 * read out before every flight code. That is not a trade worth making for a
 * feature that could not be shown to work.
 */

/**
 * Turns line breaks into sentence boundaries.
 *
 * A list rendered one item per line has no audible structure otherwise: every
 * item would run into the next. Ending each line makes the pacing right.
 */
function linesToSentences(text: string): string {
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?,:;]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

/** Splits any sentence longer than the guide's limit, preferring commas. */
function limitSentenceLength(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);

  const rebuilt = sentences.map((sentence) => {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_SPOKEN_WORDS_PER_SENTENCE) return sentence;

    // Prefer breaking at a comma; fall back to a hard word-count split. Each
    // part must end in sentence punctuation, otherwise the pieces run together
    // and the sentence is still one long breath.
    const parts: string[] = [];
    let current: string[] = [];

    const close = (): void => {
      if (current.length === 0) return;
      const piece = current.join(" ").replace(/[,;:]$/, "");
      parts.push(/[.!?]$/.test(piece) ? piece : `${piece}.`);
      current = [];
    };

    for (const word of words) {
      current.push(word);
      const longEnough = current.length >= MAX_SPOKEN_WORDS_PER_SENTENCE;
      const atComma = word.endsWith(",") && current.length >= 8;
      if (longEnough || atComma) close();
    }

    close();
    return parts.join(" ");
  });

  return rebuilt.join(" ");
}

/** Collapses whitespace and tidies punctuation left behind by the rewrites. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    // Flattening an aside that followed a sentence end leaves ".," - the comma
    // is redundant once the period is there.
    .replace(/\.\s*,/g, ".")
    .replace(/\.\s*\./g, ".")
    .trim();
}

/**
 * Returns speech-ready text.
 *
 * Idempotent: prepared text passed through again is unchanged, so it is safe
 * for the client to prepare before chunking and the server to prepare again
 * before calling Rime.
 */
export function prepareForSpeech(text: string): string {
  let out = stripWrittenFormatting(text);
  out = linesToSentences(out);
  out = flattenAsides(out);
  out = speakSymbols(out);
  out = speakCurrency(out);
  out = tidy(out);
  out = limitSentenceLength(out);
  return tidy(out);
}
