import type { MarkdownRenderResult, MarkdownRenderableBlock } from "./types.js";

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

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function renderTable(tableData: string[][]): string[] {
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

  const header = normalized[0].map(escapePipe);
  const separator = new Array(columns).fill("---");
  const body = normalized.slice(1).map(row => `| ${row.map(cell => escapePipe(cell ?? "")).join(" | ")} |`);

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

  const text = (block.text ?? "").trim();
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
        lines: renderTable(block.tableData),
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
