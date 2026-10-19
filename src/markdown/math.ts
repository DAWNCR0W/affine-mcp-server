import type MarkdownIt from "markdown-it";
import type { StateBlock, StateInline } from "markdown-it";

/**
 * TeX math delimiters, matching AFFiNE's own Markdown adapter: `$$...$$`
 * display blocks become `affine:latex` blocks and `$...$` becomes inline
 * math. Inline `$` follows Pandoc's rules so prices such as `$5 and $10`
 * stay text: the opening `$` must be followed by a non-space, the closing
 * `$` must follow a non-space and must not be followed by a digit, and the
 * formula cannot span lines. Math content is taken verbatim, so TeX
 * backslashes such as `\,` are not treated as Markdown escapes.
 */

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

function isWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x2028 || code === 0x2029;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Index of the first `needle` in `src[from, max)` that is not backslash-escaped, or -1. */
export function findUnescaped(src: string, needle: string, from: number, max: number = src.length): number {
  for (let i = from; i <= max - needle.length; i += 1) {
    if (src.charCodeAt(i) === BACKSLASH) {
      i += 1;
      continue;
    }
    if (src.startsWith(needle, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Index of the `$` closing inline math whose content starts at `from`, or -1.
 * The first unescaped `$` decides: if it cannot close, there is no math.
 */
export function findInlineMathClose(src: string, from: number, max: number = src.length): number {
  if (from >= max || isWhitespace(src.charCodeAt(from)) || src.charCodeAt(from) === DOLLAR) {
    return -1;
  }
  for (let i = from; i < max; i += 1) {
    const code = src.charCodeAt(i);
    if (code === NEWLINE) {
      return -1;
    }
    if (code === BACKSLASH) {
      if (src.charCodeAt(i + 1) === NEWLINE) {
        return -1;
      }
      i += 1;
      continue;
    }
    if (code === DOLLAR) {
      if (isWhitespace(src.charCodeAt(i - 1))) {
        return -1;
      }
      return i + 1 < max && isDigit(src.charCodeAt(i + 1)) ? -1 : i;
    }
  }
  return -1;
}

function pushMath(state: StateInline, content: string, markup: string): void {
  const token = state.push("math_inline", "math", 0);
  token.content = content;
  token.markup = markup;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  if (state.src.charCodeAt(start) !== DOLLAR) {
    return false;
  }

  if (state.src.charCodeAt(start + 1) === DOLLAR) {
    const close = findUnescaped(state.src, "$$", start + 2, max);
    const content = close < 0 ? "" : state.src.slice(start + 2, close).trim();
    if (content.length === 0) {
      // An unmatched or empty `$$` is literal text.
      if (!silent) {
        state.pending += "$$";
      }
      state.pos = start + 2;
      return true;
    }
    if (!silent) {
      pushMath(state, content, "$$");
    }
    state.pos = close + 2;
    return true;
  }

  const close = findInlineMathClose(state.src, start + 1, max);
  if (close < 0) {
    return false;
  }
  if (!silent) {
    pushMath(state, state.src.slice(start + 1, close), "$");
  }
  state.pos = close + 1;
  return true;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) {
    return false;
  }
  const opening = lineText(state, startLine);
  if (!opening.startsWith("$$")) {
    return false;
  }

  const firstLine = opening.slice(2).trimEnd();
  const sameLineClose = findUnescaped(firstLine, "$$", 0);
  let content: string;
  let lastLine = startLine;
  if (sameLineClose >= 0) {
    // `$$...$$` on one line is a block only when nothing follows the closing `$$`.
    if (sameLineClose !== firstLine.length - 2) {
      return false;
    }
    content = firstLine.slice(0, sameLineClose);
  } else {
    let closingText: string | null = null;
    for (let line = startLine + 1; line < endLine; line += 1) {
      const text = lineText(state, line);
      if (text.length > 0 && state.sCount[line] < state.blkIndent) {
        break;
      }
      const trimmed = text.trimEnd();
      if (trimmed.endsWith("$$")) {
        closingText = trimmed.slice(0, -2);
        lastLine = line;
        break;
      }
    }
    if (closingText === null) {
      return false;
    }
    const parts: string[] = [];
    if (firstLine.trim()) {
      parts.push(firstLine);
    }
    if (lastLine > startLine + 1) {
      parts.push(state.getLines(startLine + 1, lastLine, state.sCount[startLine], false));
    }
    if (closingText.trim()) {
      parts.push(closingText);
    }
    content = parts.join("\n");
  }

  if (silent) {
    return true;
  }
  state.line = lastLine + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content.trim();
  token.markup = "$$";
  token.map = [startLine, state.line];
  return true;
}

export function markdownItMath(md: MarkdownIt): void {
  md.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.inline.ruler.after("escape", "math_inline", mathInline);
}

/**
 * Renderers without math support read `$` content as Markdown, so keep it
 * inert there. A `<` before a tag-like character opens raw HTML or an
 * autolink only when a later `>` closes it, or when it starts a line (HTML
 * blocks); a space after that `<` stops it. A space after `]` stops
 * `[label](url)` links and `[label]: url` definitions. TeX ignores spaces in
 * math mode, so the formula renders the same, but the stored LaTeX changes.
 */
function inertMath(latex: string): string {
  const lastClose = latex.lastIndexOf(">");
  return latex
    .replace(/<(?=[A-Za-z/!?])/g, (lt: string, offset: number) =>
      offset < lastClose || /(?:^|\n) {0,3}$/.test(latex.slice(Math.max(0, offset - 4), offset)) ? "< " : lt)
    .replace(/\](?=[(:])/g, "] ");
}

export type RenderedMath<T> = {
  markdown: T;
  /** True when spaces were added to keep the math inert, so re-import stores different LaTeX. */
  respaced: boolean;
};

/**
 * Inline math delimited so `parseMarkdownToOperations` reads back the same
 * LaTeX, or null when no delimiter can. Pass the character that will follow
 * the closing delimiter, since a digit there prevents a single `$` close.
 */
export function renderInlineMath(latex: string, nextChar: string = ""): RenderedMath<string> | null {
  const trimmed = latex.trim();
  const value = inertMath(trimmed);
  if (value.length === 0 || /[\r\n\u2028\u2029]/.test(value)) {
    return null;
  }
  const respaced = value !== trimmed;
  const single = `$${value}$`;
  if (findInlineMathClose(single + nextChar, 1) === single.length - 1) {
    return { markdown: single, respaced };
  }
  const double = `$$${value}$$`;
  if (findUnescaped(double, "$$", 2) === double.length - 2) {
    return { markdown: double, respaced };
  }
  return null;
}

/** Display math lines for an `affine:latex` block, or null when a line would close the block early. */
export function renderDisplayMath(latex: string): RenderedMath<string[]> | null {
  const value = inertMath(latex);
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.some(line => line.trimEnd().endsWith("$$"))) {
    return null;
  }
  return { markdown: ["$$", ...lines, "$$"], respaced: value !== latex };
}
