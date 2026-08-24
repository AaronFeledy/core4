export const SELECT_PREVIEW_LAYOUT = {
  PANEL_MIN: 24,
  PANEL_MAX: 110,
  PANEL_GUTTER: 2,
  INNER_PAD: 4,
  CHROME_ROWS: 6,
  LIST_MIN_COLS: 24,
  PREVIEW_MIN_COLS: 40,
  COL_GAP: 1,
  LIST_VISIBLE_MIN: 8,
  LIST_VISIBLE_MAX: 12,
  PREVIEW_STACK_ROWS: 4,
  ROW_GAP: 1,
} as const;

export type SelectPreviewLayoutInput = {
  readonly cols: number;
  readonly rows: number;
  readonly hasPreview: boolean;
  readonly optionCount: number;
  readonly issueRows: number;
  readonly searchRows: number;
};

export type SelectPreviewLayoutMode = "side" | "stack" | "hide";

export type SelectPreviewLayout = {
  readonly mode: SelectPreviewLayoutMode;
  readonly listRows: number;
  readonly previewRows: number;
  readonly listCols: number;
  readonly previewCols: number;
};

const clamp = (min: number, value: number, max: number): number => Math.min(max, Math.max(min, value));

const assertNever = (value: never): never => {
  throw new Error(`Unexpected select preview mode: ${JSON.stringify(value)}`);
};

const listHeight = (optionCount: number, available: number): number => {
  const { LIST_VISIBLE_MAX } = SELECT_PREVIEW_LAYOUT;
  return clamp(Math.min(optionCount, LIST_VISIBLE_MAX), 2, available);
};

export const resolveSelectPreviewLayout = (input: SelectPreviewLayoutInput): SelectPreviewLayout => {
  const {
    PANEL_MIN,
    PANEL_MAX,
    PANEL_GUTTER,
    INNER_PAD,
    CHROME_ROWS,
    LIST_MIN_COLS,
    PREVIEW_MIN_COLS,
    COL_GAP,
    LIST_VISIBLE_MIN,
    PREVIEW_STACK_ROWS,
    ROW_GAP,
  } = SELECT_PREVIEW_LAYOUT;

  const panelCols = clamp(PANEL_MIN, input.cols - PANEL_GUTTER, PANEL_MAX);
  const innerCols = panelCols - INNER_PAD;
  const innerRows = Math.max(2, input.rows - (CHROME_ROWS + input.issueRows + input.searchRows));
  const sideFits = input.hasPreview && innerCols >= LIST_MIN_COLS + COL_GAP + PREVIEW_MIN_COLS;
  const stackFits = input.hasPreview && innerRows >= LIST_VISIBLE_MIN + ROW_GAP + PREVIEW_STACK_ROWS;
  const mode: SelectPreviewLayoutMode = sideFits ? "side" : stackFits ? "stack" : "hide";

  switch (mode) {
    case "side": {
      const listRows = listHeight(input.optionCount, innerRows);
      return {
        mode,
        listRows,
        previewRows: listRows,
        listCols: LIST_MIN_COLS,
        previewCols: innerCols - COL_GAP - LIST_MIN_COLS,
      };
    }
    case "stack": {
      const listRows = listHeight(input.optionCount, innerRows - ROW_GAP - PREVIEW_STACK_ROWS);
      return {
        mode,
        listRows,
        previewRows: PREVIEW_STACK_ROWS,
        listCols: innerCols,
        previewCols: innerCols,
      };
    }
    case "hide": {
      return {
        mode,
        listRows: listHeight(input.optionCount, innerRows),
        previewRows: 0,
        listCols: innerCols,
        previewCols: 0,
      };
    }
    default:
      return assertNever(mode);
  }
};
