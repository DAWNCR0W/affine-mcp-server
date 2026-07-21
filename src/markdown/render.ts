import type {
  MarkdownRenderResult,
  MarkdownRenderableBlock,
  TextDelta,
  TextDeltaAttributes,
} from "./types.js";
import {
  escapeMarkdownHtmlCommentValue,
  escapeMarkdownPlainText,
  escapeMarkdownTableCell,
  renderFencedCodeBlock,
  renderMarkdownImage,
  renderMarkdownLink,
  renderMarkdownLinkWithSafeLabel,
} from "./safety.js";
import { blobSourceIdToUrl } from "../urlSafety.js";

type RenderState = {
  blocksById: Map<string, MarkdownRenderableBlock>;
  warnings: string[];
  warningSet: Set<string>;
  unsupportedCount: number;
  unsupportedInlineAttributeCount: number;
  inlineLossSet: Set<string>;
  visited: Set<string>;
};

type RenderChunk = {
  lines: string[];
  isList: boolean;
};

function addWarning(state: RenderState, warning: string): void {
  if (!state.warningSet.has(warning)) {
    state.warningSet.add(warning);
    state.warnings.push(warning);
  }
}

type SupportedInlineAttributes = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: string | null;
  linkedPage: string | null;
};

type RenderInlineOptions = {
  trim?: boolean;
  tableCell?: boolean;
};

const BOOLEAN_INLINE_ATTRIBUTES = new Set(["bold", "italic", "strike", "code"]);

function recordInlineLoss(
  state: RenderState,
  context: string,
  attribute: string,
  reason: string,
): void {
  const key = `${context}\u0000${attribute}\u0000${reason}`;
  if (state.inlineLossSet.has(key)) {
    return;
  }
  state.inlineLossSet.add(key);
  state.unsupportedCount += 1;
  state.unsupportedInlineAttributeCount += 1;
  addWarning(
    state,
    `${context} used inline attribute '${attribute}' that Markdown export could not preserve (${reason}); text was retained without that attribute.`,
  );
}

function supportedInlineAttributes(
  attributes: TextDeltaAttributes | undefined,
  context: string,
  state: RenderState,
): SupportedInlineAttributes {
  const supported: SupportedInlineAttributes = {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    link: null,
    linkedPage: null,
  };
  if (!attributes) {
    return supported;
  }

  for (const [name, value] of Object.entries(attributes)) {
    if (BOOLEAN_INLINE_ATTRIBUTES.has(name)) {
      if (typeof value === "boolean") {
        supported[name as "bold" | "italic" | "strike" | "code"] = value;
      } else {
        recordInlineLoss(state, context, name, "expected a boolean value");
      }
      continue;
    }
    if (name === "link") {
      if (typeof value === "string" && value.length > 0) {
        supported.link = value;
      } else {
        recordInlineLoss(state, context, name, "expected a non-empty string URL");
      }
      continue;
    }
    if (name === "reference") {
      const reference = value as { type?: unknown; pageId?: unknown } | null;
      if (
        reference !== null &&
        typeof reference === "object" &&
        reference.type === "LinkedPage" &&
        typeof reference.pageId === "string" &&
        reference.pageId.length > 0
      ) {
        supported.linkedPage = reference.pageId;
      } else {
        recordInlineLoss(state, context, name, "expected a LinkedPage reference with a page id");
      }
      continue;
    }
    recordInlineLoss(state, context, name, "unsupported attribute name");
  }

  return supported;
}

function trimTextDeltas(deltas: TextDelta[]): TextDelta[] {
  const trimmed = deltas.map(delta => ({
    insert: delta.insert,
    attributes: delta.attributes ? { ...delta.attributes } : undefined,
  }));

  while (trimmed.length > 0) {
    trimmed[0].insert = trimmed[0].insert.replace(/^\s+/, "");
    if (trimmed[0].insert.length > 0) break;
    trimmed.shift();
  }
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    last.insert = last.insert.replace(/\s+$/, "");
    if (last.insert.length > 0) break;
    trimmed.pop();
  }
  return trimmed;
}

function inlineCodeFence(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(Math.max(1, longestRun + 1));
  const hasBoundarySpaces = /^\s/.test(text) && /\s$/.test(text) && /\S/.test(text);
  const needsPadding = text.startsWith("`") || text.endsWith("`") || hasBoundarySpaces;
  return `${fence}${needsPadding ? ` ${text} ` : text}${fence}`;
}

function sameSupportedInlineAttributes(
  left: SupportedInlineAttributes,
  right: SupportedInlineAttributes,
): boolean {
  return left.bold === right.bold &&
    left.italic === right.italic &&
    left.strike === right.strike &&
    left.code === right.code &&
    left.link === right.link &&
    left.linkedPage === right.linkedPage;
}

function renderTextDelta(
  insert: string,
  attributes: SupportedInlineAttributes,
  context: string,
  state: RenderState,
  options: RenderInlineOptions,
): string {
  if (insert.length === 0) {
    return "";
  }

  if (attributes.linkedPage !== null) {
    const destination = `LinkedPage:${attributes.linkedPage}`;
    const link = renderMarkdownLinkWithSafeLabel(escapeMarkdownPlainText(attributes.linkedPage), destination);
    if (link === null) {
      recordInlineLoss(state, context, "reference", "unsafe URL scheme");
      return "";
    }
    return link;
  }

  const codeCannotBePreserved = attributes.code && (
    /[\r\n\u2028\u2029]/.test(insert) ||
    (options.tableCell === true && insert.includes("|"))
  );
  if (codeCannotBePreserved) {
    recordInlineLoss(
      state,
      context,
      "code",
      options.tableCell ? "table delimiters or line breaks are unsafe in inline code" : "line breaks are unsafe in inline code",
    );
  }
  const renderAsCode = attributes.code && !codeCannotBePreserved;
  const hasFormatting =
    attributes.bold ||
    attributes.italic ||
    attributes.strike ||
    renderAsCode ||
    attributes.link !== null;

  let leading = "";
  let trailing = "";
  let content = insert;
  if (hasFormatting && !renderAsCode) {
    leading = content.match(/^ */)?.[0] ?? "";
    trailing = content.match(/ *$/)?.[0] ?? "";
    content = content.slice(leading.length, content.length - trailing.length);
    if (!content) {
      return insert;
    }
  }

  let rendered = renderAsCode ? inlineCodeFence(content) : escapeMarkdownPlainText(content);
  if (attributes.bold) rendered = `**${rendered}**`;
  if (attributes.italic) rendered = `*${rendered}*`;
  if (attributes.strike) rendered = `~~${rendered}~~`;
  if (attributes.link) {
    const link = renderMarkdownLinkWithSafeLabel(rendered, attributes.link);
    if (link === null) {
      recordInlineLoss(state, context, "link", "unsafe URL scheme");
    } else {
      rendered = link;
    }
  }
  return `${leading}${rendered}${trailing}`;
}

function renderTextDeltas(
  deltas: TextDelta[],
  context: string,
  state: RenderState,
  options: RenderInlineOptions = {},
): string {
  const renderable = options.trim === false ? deltas : trimTextDeltas(deltas);
  const runs: Array<{ insert: string; attributes: SupportedInlineAttributes }> = [];
  for (const delta of renderable) {
    const attributes = supportedInlineAttributes(delta.attributes, context, state);
    const previous = runs[runs.length - 1];
    if (previous && sameSupportedInlineAttributes(previous.attributes, attributes)) {
      previous.insert += delta.insert;
    } else {
      runs.push({ insert: delta.insert, attributes });
    }
  }
  return runs
    .map(run => renderTextDelta(run.insert, run.attributes, context, state, options))
    .join("");
}

function formatQuote(text: string): string[] {
  const lines = text.split("\n");
  return lines.map(line => `> ${line}`);
}

function formatCallout(lines: string[]): string[] {
  return [
    "> [!NOTE]",
    ...lines.map(line => line.length > 0 ? `> ${line}` : ">"),
  ];
}

function renderTable(
  tableData: string[][],
  tableCellDeltas: TextDelta[][][] | null | undefined,
  blockId: string,
  state: RenderState,
): string[] {
  if (tableData.length === 0) {
    return ["| |", "| --- |"];
  }

  const columns = tableData.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) {
    return ["| |", "| --- |"];
  }

  const normalized = tableData.map(row => {
    const copy = [...row];
    while (copy.length < columns) {
      copy.push("");
    }
    return copy;
  });

  const renderCell = (value: string, rowIndex: number, columnIndex: number): string => {
    const deltas = tableCellDeltas?.[rowIndex]?.[columnIndex];
    return deltas && deltas.length > 0
      ? renderTextDeltas(
        deltas,
        `Table block '${blockId}' cell ${rowIndex + 1}:${columnIndex + 1}`,
        state,
        { trim: false, tableCell: true },
      )
      : escapeMarkdownTableCell(value);
  };

  const header = normalized[0].map((cell, columnIndex) => renderCell(cell, 0, columnIndex));
  const separator = new Array(columns).fill("---");
  const body = normalized
    .slice(1)
    .map((row, rowIndex) =>
      `| ${row.map((cell, columnIndex) => renderCell(cell ?? "", rowIndex + 1, columnIndex)).join(" | ")} |`
    );

  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body,
  ];
}

function childList(block: MarkdownRenderableBlock): string[] {
  return Array.isArray(block.childIds) ? block.childIds : [];
}

function renderBlock(
  blockId: string,
  listDepth: number,
  state: RenderState
): RenderChunk {
  if (state.visited.has(blockId)) {
    return { lines: [], isList: false };
  }
  state.visited.add(blockId);

  const block = state.blocksById.get(blockId);
  if (!block) {
    state.unsupportedCount += 1;
    addWarning(state, `Missing block '${blockId}' while exporting markdown.`);
    return { lines: [], isList: false };
  }

  const rawText = (block.text ?? "").trim();
  const text = block.textDeltas && block.textDeltas.length > 0
    ? renderTextDeltas(block.textDeltas, `Block '${blockId}'`, state)
    : escapeMarkdownPlainText(rawText);
  const flavour = block.flavour ?? "";
  const type = block.type ?? "";
  const children = childList(block);

  switch (flavour) {
    case "affine:paragraph": {
      let lines: string[] = [];

      if (/^h[1-6]$/.test(type)) {
        const level = Number(type.slice(1));
        lines = [`${"#".repeat(level)} ${text}`.trimEnd()];
      } else if (type === "quote") {
        lines = formatQuote(text);
      } else {
        lines = [text];
      }

      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          lines.push(...child.lines);
        }
      }

      return { lines: lines.filter(line => line.length > 0), isList: false };
    }

    case "affine:list": {
      const indent = "  ".repeat(Math.max(0, listDepth));
      const style = type === "numbered" ? "numbered" : type === "todo" ? "todo" : "bulleted";
      const marker =
        style === "numbered"
          ? "1."
          : style === "todo"
            ? block.checked
              ? "- [x]"
              : "- [ ]"
            : "-";
      const lines: string[] = [`${indent}${marker}${text ? ` ${text}` : ""}`];

      for (const childId of children) {
        const child = state.blocksById.get(childId);
        const nextDepth = child?.flavour === "affine:list" ? listDepth + 1 : listDepth;
        const rendered = renderBlock(childId, nextDepth, state);
        if (rendered.lines.length > 0) {
          lines.push(...rendered.lines);
        }
      }

      return { lines, isList: true };
    }

    case "affine:code": {
      return {
        lines: renderFencedCodeBlock(block.text ?? "", block.language),
        isList: false,
      };
    }

    case "affine:divider":
      return { lines: ["---"], isList: false };

    case "affine:bookmark":
    case "affine:embed-youtube":
    case "affine:embed-github":
    case "affine:embed-figma":
    case "affine:embed-loom":
    case "affine:embed-iframe": {
      const url = (block.url ?? "").trim();
      if (!url) {
        state.unsupportedCount += 1;
        addWarning(state, `Bookmark/embed block '${blockId}' had no URL and was skipped.`);
        return { lines: [], isList: false };
      }
      const label = (block.caption ?? "").trim() || rawText || url;
      const markdownLink = renderMarkdownLink(label, url);
      if (markdownLink === null) {
        state.unsupportedCount += 1;
        addWarning(state, `Bookmark/embed block '${blockId}' used an unsafe URL scheme and was exported as plain text.`);
        return { lines: [escapeMarkdownPlainText(label)], isList: false };
      }
      return { lines: [markdownLink], isList: false };
    }

    case "affine:image": {
      const source = block.sourceId ?? "";
      if (!source.trim()) {
        state.unsupportedCount += 1;
        addWarning(state, `Image block '${blockId}' had no sourceId and was skipped.`);
        return { lines: [], isList: false };
      }
      const alt = (block.caption ?? "").trim() || "image";
      let sourceUrl: string;
      try {
        sourceUrl = blobSourceIdToUrl(source);
      } catch {
        state.unsupportedCount += 1;
        addWarning(state, `Image block '${blockId}' had an invalid sourceId and was skipped.`);
        return { lines: [], isList: false };
      }
      const markdownImage = renderMarkdownImage(alt, sourceUrl);
      if (markdownImage === null) {
        state.unsupportedCount += 1;
        addWarning(state, `Image block '${blockId}' had an unsafe source URL and was skipped.`);
        return { lines: [], isList: false };
      }
      return { lines: [markdownImage], isList: false };
    }

    case "affine:table": {
      if (!block.tableData || block.tableData.length === 0) {
        state.unsupportedCount += 1;
        addWarning(state, `Table block '${blockId}' had no readable cell data.`);
        return { lines: ["| |", "| --- |"], isList: false };
      }
      return {
        lines: renderTable(block.tableData, block.tableCellDeltas, blockId, state),
        isList: false,
      };
    }

    case "affine:callout": {
      const contentLines: string[] = [];
      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          if (contentLines.length > 0 && !child.isList) {
            contentLines.push("");
          }
          contentLines.push(...child.lines);
        }
      }
      if (contentLines.length === 0 && text.length > 0) {
        contentLines.push(text);
      }
      return {
        lines: formatCallout(contentLines),
        isList: false,
      };
    }

    case "affine:note":
    case "affine:page":
    case "affine:surface": {
      const chunks: string[] = [];
      for (const childId of children) {
        const child = renderBlock(childId, listDepth, state);
        if (child.lines.length > 0) {
          if (chunks.length > 0 && !child.isList) {
            chunks.push("");
          }
          chunks.push(...child.lines);
        }
      }
      return { lines: chunks, isList: false };
    }

    default: {
      state.unsupportedCount += 1;
      addWarning(state, `Unsupported AFFiNE block flavour '${flavour || "unknown"}' was exported as a comment placeholder.`);
      const safeFlavour = escapeMarkdownHtmlCommentValue(flavour || "unknown");
      const safeBlockId = escapeMarkdownHtmlCommentValue(blockId);
      return {
        lines: [`<!-- unsupported: flavour=${safeFlavour} blockId=${safeBlockId} -->`],
        isList: false,
      };
    }
  }
}

export function renderBlocksToMarkdown(input: {
  rootBlockIds: string[];
  blocksById: Map<string, MarkdownRenderableBlock>;
}): MarkdownRenderResult {
  const state: RenderState = {
    blocksById: input.blocksById,
    warnings: [],
    warningSet: new Set<string>(),
    unsupportedCount: 0,
    unsupportedInlineAttributeCount: 0,
    inlineLossSet: new Set<string>(),
    visited: new Set<string>(),
  };

  const chunks: RenderChunk[] = [];

  for (const rootId of input.rootBlockIds) {
    const rendered = renderBlock(rootId, 0, state);
    if (rendered.lines.length > 0) {
      chunks.push(rendered);
    }
  }

  const lines: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (i > 0) {
      const previous = chunks[i - 1];
      const shouldInsertBlank = !(previous.isList && chunk.isList);
      if (shouldInsertBlank) {
        lines.push("");
      }
    }
    lines.push(...chunk.lines);
  }

  return {
    markdown: lines.join("\n").trimEnd(),
    warnings: state.warnings,
    lossy: state.unsupportedCount > 0,
    stats: {
      blockCount: state.visited.size,
      unsupportedCount: state.unsupportedCount,
      unsupportedInlineAttributeCount: state.unsupportedInlineAttributeCount,
    },
  };
}
