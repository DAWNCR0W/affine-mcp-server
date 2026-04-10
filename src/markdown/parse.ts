import MarkdownIt from "markdown-it";
import type { MarkdownListStyle, MarkdownOperation, MarkdownParseResult, TextDelta } from "./types.js";

type TokenLike = {
  type: string;
  tag?: string;
  attrs?: Array<[string, string]>;
  level: number;
  content: string;
  info?: string;
  children?: TokenLike[];
  attrGet?: (name: string) => string | null;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});

type ParseState = {
  operations: MarkdownOperation[];
  warnings: string[];
  warningSet: Set<string>;
  unsupportedCount: number;
};

function addWarning(state: ParseState, warning: string): void {
  if (!state.warningSet.has(warning)) {
    state.warningSet.add(warning);
    state.warnings.push(warning);
  }
}

function getAttr(token: TokenLike, name: string): string {
  if (typeof token.attrGet === "function") {
    return token.attrGet(name) ?? "";
  }
  if (!Array.isArray(token.attrs)) {
    return "";
  }
  for (const [key, value] of token.attrs) {
    if (key === name) {
      return value;
    }
  }
  return "";
}

function findMatchingToken(tokens: TokenLike[], start: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === openType) {
      depth += 1;
    } else if (token.type === closeType) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findMatchingInline(tokens: TokenLike[], start: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === openType) {
      depth += 1;
    } else if (token.type === closeType) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function deltaToString(deltas: TextDelta[]): string {
  return deltas.map(delta => delta.insert).join("");
}

/**
 * Strip deltas corresponding to the first line (up to and including the first
 * "\n" separator).  Used by callout parsing to remove the `[!NOTE]` marker
 * line from the collected blockquote deltas.
 */
function stripFirstDeltaLine(deltas: TextDelta[]): TextDelta[] {
  const result: TextDelta[] = [];
  let pastNewline = false;
  for (const delta of deltas) {
    if (pastNewline) {
      result.push(delta);
      continue;
    }
    const nlIndex = delta.insert.indexOf("\n");
    if (nlIndex >= 0) {
      pastNewline = true;
      const remainder = delta.insert.slice(nlIndex + 1);
      if (remainder.length > 0) {
        result.push({ ...delta, insert: remainder });
      }
    }
  }
  return result;
}

function renderInline(children: TokenLike[]): TextDelta[] {
  function applyAttrs(deltas: TextDelta[], attrs: NonNullable<TextDelta["attributes"]>): TextDelta[] {
    return deltas.map(delta => ({
      insert: delta.insert,
      attributes: { ...delta.attributes, ...attrs },
    }));
  }

  function renderRange(start: number, end: number): TextDelta[] {
    const output: TextDelta[] = [];
    for (let i = start; i < end; i += 1) {
      const token = children[i];
      switch (token.type) {
        case "text":
        case "html_inline":
          output.push({ insert: token.content });
          break;
        case "code_inline":
          output.push({ insert: token.content, attributes: { code: true } });
          break;
        case "softbreak":
          output.push({ insert: "\n" });
          break;
        case "hardbreak":
          output.push({ insert: "  \n" });
          break;
        case "image": {
          const src = getAttr(token, "src");
          const alt = token.content ?? "";
          output.push({ insert: `![${alt}](${src})` });
          break;
        }
        case "link_open": {
          const close = findMatchingInline(children, i, "link_open", "link_close");
          if (close < 0) {
            break;
          }
          const href = getAttr(token, "href");
          const inner = renderRange(i + 1, close);
          output.push(...applyAttrs(inner.length > 0 ? inner : [{ insert: href }], { link: href }));
          i = close;
          break;
        }
        case "strong_open": {
          const close = findMatchingInline(children, i, "strong_open", "strong_close");
          if (close < 0) {
            break;
          }
          output.push(...applyAttrs(renderRange(i + 1, close), { bold: true }));
          i = close;
          break;
        }
        case "em_open": {
          const close = findMatchingInline(children, i, "em_open", "em_close");
          if (close < 0) {
            break;
          }
          output.push(...applyAttrs(renderRange(i + 1, close), { italic: true }));
          i = close;
          break;
        }
        case "s_open": {
          const close = findMatchingInline(children, i, "s_open", "s_close");
          if (close < 0) {
            break;
          }
          output.push(...applyAttrs(renderRange(i + 1, close), { strike: true }));
          i = close;
          break;
        }
        default:
          break;
      }
    }
    return output;
  }

  return renderRange(0, children.length);
}

function extractSingleLink(children: TokenLike[]): { href: string; text: string } | null {
  const filtered = children.filter(token => {
    if (token.type === "softbreak" || token.type === "hardbreak") {
      return false;
    }
    if (token.type === "text" && token.content.trim() === "") {
      return false;
    }
    return true;
  });

  if (filtered.length < 3) {
    return null;
  }

  if (filtered[0].type !== "link_open" || filtered[filtered.length - 1].type !== "link_close") {
    return null;
  }

  const href = getAttr(filtered[0], "href");
  if (!href) {
    return null;
  }

  const inner = filtered.slice(1, filtered.length - 1);
  const text = deltaToString(renderInline(inner)).trim() || href;
  return { href, text };
}

function parseTable(tokens: TokenLike[], start: number, end: number): {
  rows: number;
  columns: number;
  tableData: string[][];
  tableCellDeltas: TextDelta[][][];
} | null {
  const rows: string[][] = [];
  const rowDeltas: TextDelta[][][] = [];

  let i = start;
  while (i < end) {
    const token = tokens[i];
    if (token.type === "tr_open") {
      const trClose = findMatchingToken(tokens, i, "tr_open", "tr_close");
      if (trClose < 0 || trClose > end) {
        break;
      }
      const cells: string[] = [];
      const cellDeltas: TextDelta[][] = [];
      let j = i + 1;
      while (j < trClose) {
        const cellOpen = tokens[j];
        if (cellOpen.type === "th_open" || cellOpen.type === "td_open") {
          const cellClose = findMatchingToken(
            tokens,
            j,
            cellOpen.type,
            cellOpen.type === "th_open" ? "th_close" : "td_close"
          );
          if (cellClose < 0 || cellClose > trClose) {
            break;
          }
          let cellText = "";
          let deltas: TextDelta[] = [];
          for (let k = j + 1; k < cellClose; k += 1) {
            if (tokens[k].type === "inline") {
              deltas = renderInline(tokens[k].children ?? []);
              cellText = deltaToString(deltas).trim();
              break;
            }
          }
          cells.push(cellText);
          cellDeltas.push(deltas);
          j = cellClose + 1;
          continue;
        }
        j += 1;
      }
      rows.push(cells);
      rowDeltas.push(cellDeltas);
      i = trClose + 1;
      continue;
    }

    i += 1;
  }

  if (rows.length === 0) {
    return null;
  }

  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) {
    return null;
  }

  const tableData = rows.map(row => {
    const normalized = [...row];
    while (normalized.length < columns) {
      normalized.push("");
    }
    return normalized;
  });

  const tableCellDeltas = rowDeltas.map(row => {
    const normalized = [...row];
    while (normalized.length < columns) {
      normalized.push([]);
    }
    return normalized;
  });

  return {
    rows: tableData.length,
    columns,
    tableData,
    tableCellDeltas,
  };
}

function collectQuoteText(tokens: TokenLike[], start: number, end: number): { text: string; deltas: TextDelta[] } {
  const lines: string[] = [];
  const allDeltas: TextDelta[] = [];
  let firstLine = true;
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (token.type === "inline") {
      const lineDeltas = renderInline(token.children ?? []);
      const line = deltaToString(lineDeltas).trim();
      if (line) {
        if (!firstLine) {
          allDeltas.push({ insert: "\n" });
        }
        allDeltas.push(...lineDeltas);
        lines.push(line);
        firstLine = false;
      }
      continue;
    }
    if (token.type === "fence" || token.type === "code_block") {
      const language = (token.info ?? "").trim();
      const codeBody = token.content.replace(/\n$/, "");
      const fenceText = `\`\`\`${language}\n${codeBody}\n\`\`\``;
      if (!firstLine) {
        allDeltas.push({ insert: "\n" });
      }
      allDeltas.push({ insert: fenceText });
      lines.push(fenceText);
      firstLine = false;
      continue;
    }
  }

  return { text: lines.join("\n"), deltas: allDeltas };
}

function parseCalloutAdmonition(text: string): string | null {
  const lines = text.split("\n");
  const marker = lines[0]?.trim() ?? "";
  if (!/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i.test(marker)) {
    return null;
  }
  return lines.slice(1).join("\n").trim();
}

function parseList(
  tokens: TokenLike[],
  start: number,
  end: number,
  defaultStyle: Exclude<MarkdownListStyle, "todo">,
  state: ParseState,
  depth: number
): MarkdownOperation[] {
  const operations: MarkdownOperation[] = [];
  let i = start;

  while (i < end) {
    const token = tokens[i];
    if (token.type === "list_item_open") {
      const close = findMatchingToken(tokens, i, "list_item_open", "list_item_close");
      if (close < 0 || close > end) {
        state.unsupportedCount += 1;
        addWarning(state, "Malformed markdown list item was ignored.");
        break;
      }

      let itemText = "";
      let itemDeltas: TextDelta[] = [];
      const nestedOperations: MarkdownOperation[] = [];
      let hasNestedList = false;

      let cursor = i + 1;
      while (cursor < close) {
        const current = tokens[cursor];
        if (!itemText && current.type === "inline") {
          itemDeltas = renderInline(current.children ?? []);
          itemText = deltaToString(itemDeltas).trim();
        }

        if (current.type === "bullet_list_open" || current.type === "ordered_list_open") {
          const nestedClose = findMatchingToken(
            tokens,
            cursor,
            current.type,
            current.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close"
          );
          if (nestedClose < 0 || nestedClose > close) {
            state.unsupportedCount += 1;
            addWarning(state, "Malformed nested list was ignored.");
            break;
          }
          hasNestedList = true;
          const nestedStyle = current.type === "ordered_list_open" ? "numbered" : "bulleted";
          nestedOperations.push(...parseList(tokens, cursor + 1, nestedClose, nestedStyle, state, depth + 1));
          cursor = nestedClose + 1;
          continue;
        }

        cursor += 1;
      }

      let style: MarkdownListStyle = defaultStyle;
      let checked: boolean | undefined;
      const taskMatch = itemText.match(/^\[(\s|x|X)\]\s+([\s\S]*)$/);
      if (taskMatch) {
        style = "todo";
        checked = taskMatch[1].toLowerCase() === "x";
        itemText = taskMatch[2];
        const prefixLen = deltaToString(itemDeltas).length - itemText.length;
        let remaining = prefixLen;
        const trimmedDeltas: TextDelta[] = [];
        for (const delta of itemDeltas) {
          if (remaining <= 0) {
            trimmedDeltas.push(delta);
            continue;
          }
          if (remaining >= delta.insert.length) {
            remaining -= delta.insert.length;
            continue;
          }
          trimmedDeltas.push({ ...delta, insert: delta.insert.slice(remaining) });
          remaining = 0;
        }
        itemDeltas = trimmedDeltas;
      }

      operations.push({
        type: "list",
        text: itemText,
        style,
        ...(style === "todo" ? { checked: Boolean(checked) } : {}),
        deltas: itemDeltas,
      });

      if (hasNestedList) {
        state.unsupportedCount += 1;
        addWarning(state, "Nested markdown lists were flattened to sequential list items.");
      }
      operations.push(...nestedOperations);
      i = close + 1;
      continue;
    }

    i += 1;
  }

  if (depth > 0 && operations.length > 0) {
    state.unsupportedCount += 1;
    addWarning(state, "List nesting depth was reduced during markdown import.");
  }

  return operations;
}

function parseTokens(tokens: TokenLike[], start: number, end: number, state: ParseState): void {
  let i = start;

  while (i < end) {
    const token = tokens[i];

    switch (token.type) {
      case "heading_open": {
        const close = findMatchingToken(tokens, i, "heading_open", "heading_close");
        if (close < 0 || close >= end) {
          state.unsupportedCount += 1;
          addWarning(state, "Malformed markdown heading was ignored.");
          i += 1;
          break;
        }

        const levelNum = Number((token.tag ?? "h1").replace("h", ""));
        const level = Math.max(1, Math.min(6, levelNum)) as 1 | 2 | 3 | 4 | 5 | 6;
        const inline = tokens.slice(i + 1, close).find(inner => inner.type === "inline");
        const headingDeltas = inline ? renderInline(inline.children ?? []) : [];
        const text = deltaToString(headingDeltas).trim();
        state.operations.push({ type: "heading", level, text, deltas: headingDeltas });
        i = close + 1;
        break;
      }

      case "paragraph_open": {
        const close = findMatchingToken(tokens, i, "paragraph_open", "paragraph_close");
        if (close < 0 || close >= end) {
          state.unsupportedCount += 1;
          addWarning(state, "Malformed markdown paragraph was ignored.");
          i += 1;
          break;
        }

        const inline = tokens.slice(i + 1, close).find(inner => inner.type === "inline");
        if (!inline) {
          i = close + 1;
          break;
        }

        const children = inline.children ?? [];
        const singleLink = extractSingleLink(children);
        if (singleLink) {
          state.operations.push({
            type: "bookmark",
            url: singleLink.href,
            caption: singleLink.text,
          });
          i = close + 1;
          break;
        }

        if (children.length === 1 && children[0].type === "image") {
          const imageToken = children[0];
          const src = getAttr(imageToken, "src");
          const alt = imageToken.content || undefined;
          if (src) {
            state.unsupportedCount += 1;
            addWarning(state, "Markdown images were imported as bookmark blocks (external image blobs are not auto-uploaded).");
            state.operations.push({ type: "bookmark", url: src, caption: alt });
          }
          i = close + 1;
          break;
        }

        const paragraphDeltas = renderInline(children);
        const text = deltaToString(paragraphDeltas).trim();
        if (text.length > 0) {
          state.operations.push({ type: "paragraph", text, deltas: paragraphDeltas });
        }
        i = close + 1;
        break;
      }

      case "fence":
      case "code_block": {
        const language = (token.info ?? "").trim() || undefined;
        const code = token.content.replace(/\n$/, "");
        state.operations.push({ type: "code", text: code, language });
        i += 1;
        break;
      }

      case "hr":
        state.operations.push({ type: "divider" });
        i += 1;
        break;

      case "blockquote_open": {
        const close = findMatchingToken(tokens, i, "blockquote_open", "blockquote_close");
        if (close < 0 || close >= end) {
          state.unsupportedCount += 1;
          addWarning(state, "Malformed blockquote was ignored.");
          i += 1;
          break;
        }
        const quoteResult = collectQuoteText(tokens, i + 1, close);
        const quoteText = quoteResult.text.trim();
        const calloutText = parseCalloutAdmonition(quoteText);
        if (calloutText !== null) {
          state.operations.push({ type: "callout", text: calloutText, deltas: stripFirstDeltaLine(quoteResult.deltas) });
        } else if (quoteText.length > 0) {
          state.operations.push({ type: "quote", text: quoteText, deltas: quoteResult.deltas });
        }
        i = close + 1;
        break;
      }

      case "bullet_list_open":
      case "ordered_list_open": {
        const close = findMatchingToken(
          tokens,
          i,
          token.type,
          token.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close"
        );
        if (close < 0 || close >= end) {
          state.unsupportedCount += 1;
          addWarning(state, "Malformed markdown list was ignored.");
          i += 1;
          break;
        }
        const style = token.type === "ordered_list_open" ? "numbered" : "bulleted";
        state.operations.push(...parseList(tokens, i + 1, close, style, state, 0));
        i = close + 1;
        break;
      }

      case "table_open": {
        const close = findMatchingToken(tokens, i, "table_open", "table_close");
        if (close < 0 || close >= end) {
          state.unsupportedCount += 1;
          addWarning(state, "Malformed markdown table was ignored.");
          i += 1;
          break;
        }
        const parsedTable = parseTable(tokens, i + 1, close);
        if (!parsedTable) {
          state.unsupportedCount += 1;
          addWarning(state, "Unsupported markdown table structure was ignored.");
          i = close + 1;
          break;
        }
        state.operations.push({
          type: "table",
          rows: parsedTable.rows,
          columns: parsedTable.columns,
          tableData: parsedTable.tableData,
          tableCellDeltas: parsedTable.tableCellDeltas,
        });
        i = close + 1;
        break;
      }

      case "html_block": {
        const raw = token.content.trim();
        if (raw) {
          state.unsupportedCount += 1;
          addWarning(state, "HTML blocks were imported as plain paragraph text.");
          state.operations.push({ type: "paragraph", text: raw });
        }
        i += 1;
        break;
      }

      default:
        i += 1;
        break;
    }
  }
}

export function parseMarkdownToOperations(markdown: string): MarkdownParseResult {
  const state: ParseState = {
    operations: [],
    warnings: [],
    warningSet: new Set<string>(),
    unsupportedCount: 0,
  };

  const source = markdown ?? "";
  const tokens = md.parse(source, {}) as unknown as TokenLike[];
  parseTokens(tokens, 0, tokens.length, state);

  return {
    operations: state.operations,
    warnings: state.warnings,
    lossy: state.unsupportedCount > 0,
    stats: {
      inputChars: source.length,
      blockCount: state.operations.length,
      unsupportedCount: state.unsupportedCount,
    },
  };
}
