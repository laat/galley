// For each run of "*", "_" or "~" that may open emphasis or strikethrough, marked scans the rest of the
// paragraph for the run that closes it. Without one, it moves on a character and scans again for the rest
// of the run. A paragraph with n such characters takes time up to n²: 50,000 characters of "*a " took 16 s,
// on the thread that serves every page. Markdown with too many is shown as plain text.
import { Lexer } from 'marked';

/**
 * Runs that may open emphasis or strikethrough: followed by a non-space. That counts "_" inside words too,
 * which marked mostly skips, but not after a letter outside the Basic Multilingual Plane, of which it sees half.
 */
const OPENERS = /\*+(?=\S)|_+(?=\S)|~+(?=\S)/g;
/** The characters in openers in each paragraph, squared and summed: 1,000 in one paragraph, up to 150 ms. */
const MAX_WORK = 1_000 ** 2;

/**
 * Whether marked takes too long over the Markdown `text`. Counts the openers in each paragraph, heading and
 * table cell, the pieces marked reads for emphasis one by one, and none in code blocks.
 */
export function tooMuchEmphasis(text: string): boolean {
  const lexer = new Lexer({ gfm: true, breaks: true });
  // The blocks marked.parse finds. Their inline text waits in the queue, unread.
  lexer.blockTokens(text.replace(/\r\n|\r/g, '\n'));
  let work = 0;
  for (const { src } of lexer.inlineQueue) work += (src.match(OPENERS)?.join('').length ?? 0) ** 2;
  return work > MAX_WORK;
}
