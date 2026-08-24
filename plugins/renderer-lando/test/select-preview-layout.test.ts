import { describe, expect, test } from "bun:test";

import { resolveSelectPreviewLayout } from "../src/opentui/select-preview-layout.ts";

const layout = (input: {
  readonly cols: number;
  readonly rows: number;
  readonly hasPreview: boolean;
  readonly optionCount: number;
  readonly issueRows: number;
  readonly searchRows: number;
}) => resolveSelectPreviewLayout(input);

describe("resolveSelectPreviewLayout", () => {
  test("uses side-by-side preview at 80x24 with descriptions", () => {
    const resolved = layout({
      cols: 80,
      rows: 24,
      hasPreview: true,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).toBe("side");
    expect(resolved.listRows).toBe(12);
    expect(resolved.previewRows).toBe(12);
    expect(resolved.listCols).toBe(24);
    expect(resolved.previewCols).toBeGreaterThanOrEqual(40);
  });

  test("is not side at 70 columns", () => {
    const resolved = layout({
      cols: 70,
      rows: 24,
      hasPreview: true,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).not.toBe("side");
  });

  test("is side at 71 columns", () => {
    const resolved = layout({
      cols: 71,
      rows: 24,
      hasPreview: true,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).toBe("side");
  });

  test("hides preview at 50x18", () => {
    const resolved = layout({
      cols: 50,
      rows: 18,
      hasPreview: true,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).toBe("hide");
  });

  test("stacks preview at 50x19", () => {
    const resolved = layout({
      cols: 50,
      rows: 19,
      hasPreview: true,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).toBe("stack");
  });

  test("hides preview when hasPreview is false at 80x24", () => {
    const resolved = layout({
      cols: 80,
      rows: 24,
      hasPreview: false,
      optionCount: 20,
      issueRows: 0,
      searchRows: 0,
    });
    expect(resolved.mode).toBe("hide");
    expect(resolved.previewRows).toBe(0);
  });
});
