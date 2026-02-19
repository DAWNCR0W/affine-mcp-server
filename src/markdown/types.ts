export type MarkdownListStyle = "bulleted" | "numbered" | "todo";

export type MarkdownOperation =
  | {
      type: "heading";
      text: string;
      level: 1 | 2 | 3 | 4 | 5 | 6;
    }
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "quote";
      text: string;
    }
  | {
      type: "list";
      text: string;
      style: MarkdownListStyle;
      checked?: boolean;
    }
  | {
      type: "code";
      text: string;
      language?: string;
    }
  | {
      type: "divider";
    }
  | {
      type: "table";
      rows: number;
      columns: number;
      tableData: string[][];
    }
  | {
      type: "bookmark";
      url: string;
      caption?: string;
    };

export type MarkdownParseResult = {
  operations: MarkdownOperation[];
  warnings: string[];
  lossy: boolean;
  stats: {
    inputChars: number;
    blockCount: number;
    unsupportedCount: number;
  };
};

export type MarkdownRenderableBlock = {
  id: string;
  parentId: string | null;
  flavour: string | null;
  type: string | null;
  text: string | null;
  checked: boolean | null;
  language: string | null;
  childIds: string[];
  url: string | null;
  sourceId: string | null;
  caption: string | null;
  tableData: string[][] | null;
};

export type MarkdownRenderResult = {
  markdown: string;
  warnings: string[];
  lossy: boolean;
  stats: {
    blockCount: number;
    unsupportedCount: number;
  };
};
