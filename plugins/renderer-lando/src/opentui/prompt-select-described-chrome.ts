import type { KeyEventLike, RenderableLike, RendererLike } from "./prompt-driver-types.ts";
import { SELECT_PREVIEW_LAYOUT, type SelectPreviewLayout } from "./select-preview-layout.ts";

/** OpenTUI `TextAttributes.BOLD` — avoid a static `@opentui/core` import. */
export const TEXT_BOLD = 1;

export const describedPanelWidth = (renderer: RendererLike): number =>
  Math.max(
    SELECT_PREVIEW_LAYOUT.PANEL_MIN,
    Math.min(SELECT_PREVIEW_LAYOUT.PANEL_MAX, renderer.width - SELECT_PREVIEW_LAYOUT.PANEL_GUTTER),
  );

export const issueRowsOf = (request: { readonly issue?: string }): number =>
  request.issue !== undefined && request.issue.length > 0 ? 1 : 0;

export const printableChar = (key: KeyEventLike): string | undefined => {
  if (key.ctrl === true) return undefined;
  const sequence = key.sequence ?? "";
  if (sequence.length === 1) {
    const code = sequence.charCodeAt(0);
    if (code >= 32 && code < 127) return sequence;
  }
  const name = key.name ?? "";
  if (name.length === 1 && name >= " " && name <= "~") return name;
  return undefined;
};

export type PreviewChrome = {
  readonly body: RenderableLike;
  readonly select: RenderableLike;
  readonly preview: RenderableLike;
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected select preview mode: ${JSON.stringify(value)}`);
};

export const applyMode = (next: SelectPreviewLayout, chrome: PreviewChrome): void => {
  switch (next.mode) {
    case "side":
      chrome.body.flexDirection = "row";
      chrome.preview.visible = true;
      break;
    case "stack":
      chrome.body.flexDirection = "column";
      chrome.preview.visible = true;
      break;
    case "hide":
      chrome.body.flexDirection = "column";
      chrome.preview.visible = false;
      break;
    default:
      assertNever(next.mode);
  }
  chrome.select.width = next.listCols;
  chrome.select.height = next.listRows;
  chrome.preview.width = Math.max(0, next.previewCols);
  chrome.preview.height = Math.max(0, next.previewRows);
};
