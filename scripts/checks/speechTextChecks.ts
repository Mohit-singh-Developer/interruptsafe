/**
 * Throwaway verification of prepareForSpeech against Rime's official guidance.
 * Scratchpad only, NOT committed.
 */
const mod = (await import(
  "../../packages/shared/src/speechText.ts"
)) as any;
const { prepareForSpeech } = mod;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected=${JSON.stringify(expected)}\n        actual  =${JSON.stringify(actual)}`),
  );
}
function contains(label: string, haystack: string, needle: string, want = true): void {
  check(label, haystack.includes(needle), want);
}

console.log("--- written-only formatting is removed ---");
{
  check("bullets are dropped", prepareForSpeech("- one\n- two"), "one. two.");
  check("numbered markers are dropped", prepareForSpeech("1. one\n2. two"), "one. two.");
  // A line with no terminal punctuation gains a period: a spoken sentence
  // should end, otherwise it runs into whatever follows.
  check("markdown emphasis is dropped", prepareForSpeech("**bold** and *italic*"), "bold and italic.");
  check("headings are dropped", prepareForSpeech("## Heading"), "Heading.");
  check("inline code backticks are dropped", prepareForSpeech("run `npm test` now"), "run npm test now.");
}

console.log("\n--- symbols are spoken as words ---");
{
  contains("arrow becomes 'to'", prepareForSpeech("Delhi -> Mumbai"), " to ");
  contains("arrow is not left as ->", prepareForSpeech("Delhi -> Mumbai"), "->", false);
  contains("unicode arrow handled", prepareForSpeech("Delhi → Mumbai"), " to ");
  contains("ampersand becomes 'and'", prepareForSpeech("bed & breakfast"), " and ");
}

console.log("\n--- non-dollar currency is written out (official rule) ---");
{
  contains("INR becomes rupees", prepareForSpeech("approx INR 3586"), "3586 rupees");
  contains("INR token is gone", prepareForSpeech("approx INR 3586"), "INR", false);
}

console.log("\n--- parenthetical asides are flattened ---");
{
  const out = prepareForSpeech("3 flights found (synthetic data) today.");
  contains("brackets removed", out, "(", false);
  contains("content preserved", out, "synthetic data");
}

console.log("\n--- no SSML or markup is ever emitted ---");
{
  const out = prepareForSpeech("Some text with <break/> and <emotion>x</emotion>.");
  contains("no break tag emitted", out, "<break", false);
  contains("no emotion tag emitted", out, "<emotion", false);
  contains("no spell() emitted", prepareForSpeech("code IS486"), "spell(", false);
}

console.log("\n--- sentence length is capped (Rime: under 25 words) ---");
{
  const long = `${"word ".repeat(60)}end.`;
  const out = prepareForSpeech(long);
  const longest = out
    .split(/(?<=[.!?])\s+/)
    .map((s: string) => s.split(/\s+/).filter(Boolean).length)
    .reduce((a: number, b: number) => Math.max(a, b), 0);
  check("no spoken sentence exceeds 25 words", longest <= 25, true);
}

console.log("\n--- THE REAL CASE: an actual mock tool reply ---");
{
  const reply =
    '3 mock flights from Delhi to Mumbai. (MOCK DATA from searchFlights - synthetic, not real information.)\n' +
    '- IS486  Delhi -> Mumbai  departs 08:00  approx INR 3586\n' +
    '- IS499  Delhi -> Mumbai  departs 15:00  approx INR 3897';

  const out = prepareForSpeech(reply);
  console.log(`   spoken: ${out}`);

  contains("no bullet dashes", out, "- IS", false);
  contains("no arrows", out, "->", false);
  contains("no brackets", out, "(", false);
  contains("no INR token", out, "INR", false);
  contains("rupees spoken", out, "rupees");
  contains("flight code preserved", out, "IS486");
  contains("route spoken naturally", out, "Delhi to Mumbai");
  check("no double spaces", /\s{2,}/.test(out), false);
}

console.log("\n--- idempotence: safe to apply on client AND server ---");
{
  const reply =
    '3 mock flights from Delhi to Mumbai. (MOCK DATA - synthetic.)\n- IS486 Delhi -> Mumbai approx INR 3586';
  const once = prepareForSpeech(reply);
  const twice = prepareForSpeech(once);
  check("applying twice changes nothing", twice, once);
}

console.log("\n--- the semantic answer is not altered ---");
{
  const plain = 'You said: "Hello" (1 word, 5 characters). This is a deterministic mock response - no language model was called.';
  const out = prepareForSpeech(plain);
  contains("the quoted word survives", out, "Hello");
  contains("the word count survives", out, "1 word");
  contains("the disclaimer survives", out, "deterministic mock response");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
