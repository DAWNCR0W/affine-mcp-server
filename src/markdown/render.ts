import type { MarkdownRenderResult, MarkdownRenderableBlock, TextDelta } from "./types.js";

type RenderState = {
  blocksById: Map<string, MarkdownRenderableBlock>;
  warnings: string[];
  warningSet: Set<string>;
  unsupportedCount: number;
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

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderCell(text: string, deltas: TextDelta[] | undefined): string {
  return escapePipe(deltas && deltas.length > 0 ? deltasToMarkdown(deltas) : text);
}

function renderTable(tableData: string[][], tableCellDeltas?: TextDelta[][][]): string[] {
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

  const header = normalized[0].map((cell, colIdx) =>
    renderCell(cell, tableCellDeltas?.[0]?.[colIdx])
  );
  const separator = new Array(columns).fill("---");
  const body = normalized.slice(1).map((row, rowIdx) =>
    `| ${row.map((cell, colIdx) => renderCell(cell, tableCellDeltas?.[rowIdx + 1]?.[colIdx])).join(" | ")} |`
  );

  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...body,
  ];
}

function attrsEqual(a: TextDelta["attributes"], b: TextDelta["attributes"]): boolean {
  const aA = a ?? {};
  const bA = b ?? {};
  return (
    !!aA.bold === !!bA.bold &&
    !!aA.italic === !!bA.italic &&
    !!aA.strike === !!bA.strike &&
    !!aA.code === !!bA.code &&
    (aA.link ?? null) === (bA.link ?? null)
  );
}

// Coalesce adjacent runs with identical attributes and drop empty inserts.
// Adjacent same-attribute runs would otherwise produce delimiter doublings
// (e.g. `**A****B**`), which CommonMark parses as literal asterisks inside
// the span.  An empty-insert run with marks would emit floating delimiters
// for nothing — easiest to skip outright.
function coalesceDeltas(deltas: TextDelta[]): TextDelta[] {
  const result: TextDelta[] = [];
  for (const d of deltas) {
    if (d.insert === "") continue;
    const last = result[result.length - 1];
    if (last && attrsEqual(last.attributes, d.attributes)) {
      result[result.length - 1] = { ...last, insert: last.insert + d.insert };
    } else {
      result.push(d);
    }
  }
  return result;
}

// Build a code span with a backtick fence longer than any run of backticks in
// the content, padding with spaces if the content starts or ends with a
// backtick (CommonMark strips one leading/trailing space when both are present).
function emitCodeFence(content: string): string {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  const fence = "`".repeat(max + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

export function deltasToMarkdown(deltas: TextDelta[]): string {
  // Each run is wrapped in standard CommonMark delimiters: `**bold**`,
  // `_italic_`, and `***bold+italic***`.  Concatenating per-run keeps boundary
  // parsing unambiguous — e.g. `**A*****B***_C_` parses as
  // <strong>A</strong><em><strong>B</strong></em><em>C</em>, which round-trips
  // back through parseMarkdownToOperations to the original delta structure.
  // Underscore is used for standalone italic so it never sits next to a `**`
  // bold delimiter; `***` for bold+italic avoids any `_` inside a `**...**`
  // span (which CommonMark's intra-word-underscore rule would treat as literal).
  let result = "";
  for (const d of coalesceDeltas(deltas)) {
    const attrs = d.attributes ?? {};
    let inner = d.insert;
    if (attrs.code) {
      inner = emitCodeFence(inner);
    } else {
      if (attrs.bold && attrs.italic) inner = `***${inner}***`;
      else if (attrs.bold) inner = `**${inner}**`;
      else if (attrs.italic) inner = `_${inner}_`;
    }
    if (attrs.link) {
      const label = inner.replace(/]/g, "\\]");
      // URLs with whitespace or angle brackets aren't valid in the
      // non-angle-bracket destination form; switch to <…> and percent-encode
      // any inner < or > so the destination remains parseable.
      const needsAngle = /[\s<>]/.test(attrs.link);
      const href = needsAngle
        ? `<${attrs.link.replace(/</g, "%3C").replace(/>/g, "%3E")}>`
        : attrs.link;
      inner = `[${label}](${href})`;
    }
    if (attrs.strike) inner = `~~${inner}~~`;
    result += inner;
  }
  return result;
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

  const text = (block.deltas && block.deltas.length > 0
    ? deltasToMarkdown(block.deltas)
    : (block.text ?? "")).trim();
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
      const language = block.language ?? "";
      const lines = [`\`\`\`${language}`, block.text ?? "", "\`\`\`"];
      return { lines, isList: false };
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
      const label = (block.caption ?? "").trim() || text || url;
      return { lines: [`[${label}](${url})`], isList: false };
    }

    case "affine:image": {
      const source = (block.sourceId ?? "").trim();
      if (!source) {
        state.unsupportedCount += 1;
        addWarning(state, `Image block '${blockId}' had no sourceId and was skipped.`);
        return { lines: [], isList: false };
      }
      const alt = (block.caption ?? "").trim() || "image";
      return { lines: [`![${alt}](affine://blob/${source})`], isList: false };
    }

    case "affine:table": {
      if (!block.tableData || block.tableData.length === 0) {
        state.unsupportedCount += 1;
        addWarning(state, `Table block '${blockId}' had no readable cell data.`);
        return { lines: ["| |", "| --- |"], isList: false };
      }
      return {
        lines: renderTable(block.tableData, block.tableCellDeltas),
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
      return {
        lines: [`<!-- unsupported: flavour=${flavour || "unknown"} blockId=${blockId} -->`],
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
    },
  };
}
