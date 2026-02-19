import MarkdownIt from "markdown-it";
import type { MarkdownListStyle, MarkdownOperation, MarkdownParseResult } from "./types.js";

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

function renderInline(children: TokenLike[]): string {
  function renderRange(start: number, end: number): string {
    let output = "";
    for (let i = start; i < end; i += 1) {
      const token = children[i];
      switch (token.type) {
        case "text":
        case "html_inline":
          output += token.content;
          break;
        case "code_inline":
          output += `\`${token.content}\``;
          break;
        case "softbreak":
          output += "\n";
          break;
        case "hardbreak":
          output += "  \n";
          break;
        case "image": {
          const src = getAttr(token, "src");
          const alt = token.content ?? "";
          output += `![${alt}](${src})`;
          break;
        }
        case "link_open": {
          const close = findMatchingInline(children, i, "link_open", "link_close");
          if (close < 0) {
            break;
          }
          const href = getAttr(token, "href");
          const title = getAttr(token, "title");
          const inner = renderRange(i + 1, close);
          const titlePart = title ? ` \"${title}\"` : "";
          output += `[${inner}](${href}${titlePart})`;
          i = close;
          break;
        }
        case "strong_open": {
          const close = findMatchingInline(children, i, "strong_open", "strong_close");
          if (close < 0) {
            break;
          }
          output += `**${renderRange(i + 1, close)}**`;
          i = close;
          break;
        }
        case "em_open": {
          const close = findMatchingInline(children, i, "em_open", "em_close");
          if (close < 0) {
            break;
          }
          output += `*${renderRange(i + 1, close)}*`;
          i = close;
          break;
        }
        case "s_open": {
          const close = findMatchingInline(children, i, "s_open", "s_close");
          if (close < 0) {
            break;
          }
          output += `~~${renderRange(i + 1, close)}~~`;
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
  const text = renderInline(inner).trim() || href;
  return { href, text };
}

function parseTable(tokens: TokenLike[], start: number, end: number): { rows: number; columns: number; tableData: string[][] } | null {
  const rows: string[][] = [];

  let i = start;
  while (i < end) {
    const token = tokens[i];
    if (token.type === "tr_open") {
      const trClose = findMatchingToken(tokens, i, "tr_open", "tr_close");
      if (trClose < 0 || trClose > end) {
        break;
      }
      const cells: string[] = [];
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
          for (let k = j + 1; k < cellClose; k += 1) {
            if (tokens[k].type === "inline") {
              cellText = renderInline(tokens[k].children ?? []).trim();
              break;
            }
          }
          cells.push(cellText);
          j = cellClose + 1;
          continue;
        }
        j += 1;
      }
      rows.push(cells);
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

  return {
    rows: tableData.length,
    columns,
    tableData,
  };
}

function collectQuoteText(tokens: TokenLike[], start: number, end: number): string {
  const lines: string[] = [];
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (token.type === "inline") {
      const line = renderInline(token.children ?? []).trim();
      if (line) {
        lines.push(line);
      }
      continue;
    }
    if (token.type === "fence" || token.type === "code_block") {
      const language = (token.info ?? "").trim();
      const codeBody = token.content.replace(/\n$/, "");
      lines.push(`\`\`\`${language}\n${codeBody}\n\`\`\``);
      continue;
    }
  }

  return lines.join("\n");
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
      const nestedOperations: MarkdownOperation[] = [];
      let hasNestedList = false;

      let cursor = i + 1;
      while (cursor < close) {
        const current = tokens[cursor];
        if (!itemText && current.type === "inline") {
          itemText = renderInline(current.children ?? []).trim();
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
      }

      operations.push({
        type: "list",
        text: itemText,
        style,
        ...(style === "todo" ? { checked: Boolean(checked) } : {}),
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
        const text = inline ? renderInline(inline.children ?? []).trim() : "";
        state.operations.push({ type: "heading", level, text });
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

        const text = renderInline(children).trim();
        if (text.length > 0) {
          state.operations.push({ type: "paragraph", text });
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
        const quoteText = collectQuoteText(tokens, i + 1, close).trim();
        if (quoteText.length > 0) {
          state.operations.push({ type: "quote", text: quoteText });
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
