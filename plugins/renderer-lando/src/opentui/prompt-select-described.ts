import { rankFuzzy } from "@lando/sdk/fuzzy";

import { wrapWordsToWidth } from "../terminal-width.ts";
import { choiceDescription, choiceLabel, selectedChoiceIndex } from "./prompt-choice.ts";
import type {
  KeyEventLike,
  OpenTuiModuleLike,
  PromptDriverRequestLike,
  RenderableLike,
  RendererLike,
  SelectOptionLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, removeListener } from "./prompt-listeners.ts";
import {
  TEXT_BOLD,
  applyMode,
  describedPanelWidth,
  issueRowsOf,
  printableChar,
} from "./prompt-select-described-chrome.ts";
import { PROMPT_THEME, promptSelectColors } from "./prompt-theme.ts";
import { SELECT_PREVIEW_LAYOUT, resolveSelectPreviewLayout } from "./select-preview-layout.ts";

export const addDescribedSelect = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): PromptDisposer => {
  const choices = request.choices ?? request.prompt.choices ?? [];
  const defaultRaw =
    request.defaultRaw ?? (request.prompt.default === undefined ? undefined : String(request.prompt.default));
  const catalog: SelectOptionLike[] = choices.map((choice, index) => ({
    name: choiceLabel(choice),
    description: "",
    value: String(index + 1),
  }));
  const issueRows = issueRowsOf(request);
  let query = "";
  let catalogHighlight = selectedChoiceIndex(choices, defaultRaw);
  let searchAttached = false;
  let layout = resolveSelectPreviewLayout({
    cols: renderer.width,
    rows: renderer.height,
    hasPreview: true,
    optionCount: catalog.length,
    issueRows,
    searchRows: 0,
  });

  const body = new mod.BoxRenderable(renderer, {
    id: "lando-prompt-select-body",
    flexDirection: layout.mode === "side" ? "row" : "column",
    gap: 1,
    width: Math.max(10, describedPanelWidth(renderer) - SELECT_PREVIEW_LAYOUT.INNER_PAD),
  });
  const select = new mod.SelectRenderable(renderer, {
    id: "lando-prompt-select",
    width: layout.listCols,
    height: layout.listRows,
    options: catalog,
    showDescription: false,
    selectedIndex: catalogHighlight,
    ...promptSelectColors,
    showScrollIndicator: false,
  });
  const preview = new mod.BoxRenderable(renderer, {
    id: "lando-prompt-select-preview",
    flexDirection: "column",
    width: Math.max(1, layout.previewCols),
    height: Math.max(0, layout.previewRows),
  });
  const previewTitle = new mod.TextRenderable(renderer, {
    id: "lando-prompt-select-preview-title",
    content: "",
    fg: PROMPT_THEME.text,
    attributes: TEXT_BOLD,
    width: Math.max(1, layout.previewCols),
  });
  const previewBody = new mod.TextRenderable(renderer, {
    id: "lando-prompt-select-preview-body",
    content: "",
    fg: PROMPT_THEME.muted,
    width: Math.max(1, layout.previewCols),
  });
  const search = new mod.TextRenderable(renderer, {
    id: "lando-prompt-select-search",
    content: "",
    fg: PROMPT_THEME.accent,
    height: 1,
  });
  preview.add?.(previewTitle);
  preview.add?.(previewBody);

  const descriptionFor = (option: SelectOptionLike | undefined): string => {
    if (option === undefined) return "";
    const original = Number(option.value) - 1;
    const choice = choices[original];
    return choice === undefined ? "" : (choiceDescription(choice) ?? "");
  };

  const paintPreview = (index: number): void => {
    const option = select.options[index];
    const title = option?.name ?? "";
    const description = descriptionFor(option);
    const width = Math.max(1, layout.previewCols);
    if (layout.mode === "hide") {
      previewTitle.content = "";
      previewBody.content = "";
      return;
    }
    if (layout.mode === "side") {
      const titleLines = wrapWordsToWidth(title, width);
      previewTitle.visible = true;
      previewTitle.content = titleLines.join("\n");
      previewTitle.width = width;
      previewTitle.height = Math.min(titleLines.length, layout.previewRows);
      previewBody.content = description === "" ? "" : wrapWordsToWidth(description, width).join("\n");
      previewBody.width = width;
      previewBody.height = Math.max(0, layout.previewRows - titleLines.length);
      return;
    }
    previewTitle.visible = false;
    previewTitle.content = "";
    previewTitle.height = 0;
    previewBody.content = wrapWordsToWidth(description, width).join("\n");
    previewBody.width = width;
    previewBody.height = layout.previewRows;
  };

  const applyLayout = (): void => {
    layout = resolveSelectPreviewLayout({
      cols: renderer.width,
      rows: renderer.height,
      hasPreview: true,
      optionCount: catalog.length,
      issueRows,
      searchRows: query === "" ? 0 : 1,
    });
    panel.width = describedPanelWidth(renderer);
    body.width = Math.max(10, describedPanelWidth(renderer) - SELECT_PREVIEW_LAYOUT.INNER_PAD);
    applyMode(layout, { body, select, preview });
    paintPreview(select.getSelectedIndex());
    renderer.requestRender?.();
  };

  const applyQuery = (next: string): void => {
    query = next;
    if (query === "") {
      if (searchAttached) {
        panel.remove?.(search);
        searchAttached = false;
      }
      select.options = catalog;
      select.setSelectedIndex?.(catalogHighlight < catalog.length ? catalogHighlight : 0);
      applyLayout();
      return;
    }
    if (!searchAttached) {
      panel.add?.(search, issueRows);
      searchAttached = true;
    }
    search.content = query;
    const hits = rankFuzzy(query, catalog, (option) => option.name);
    select.options = hits.map((hit) => hit.item);
    if (hits.length > 0) select.setSelectedIndex?.(0);
    applyLayout();
  };

  paintPreview(catalogHighlight);
  applyMode(layout, { body, select, preview });
  body.add?.(select);
  body.add?.(preview);
  panel.add?.(body);
  select.focus?.();

  const onSelection = (index: number): void => {
    if (query === "") catalogHighlight = index;
    paintPreview(index);
  };
  select.on(mod.SelectRenderableEvents.SELECTION_CHANGED, onSelection);
  select.on(mod.SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const option = select.options[index];
    if (option?.value === undefined) return;
    done(String(option.value));
  });

  const onKey = (key: KeyEventLike): void => {
    if (query !== "" && key.name === "escape") {
      key.preventDefault?.();
      applyQuery("");
      return;
    }
    if (key.name === "backspace") {
      if (query === "") return;
      key.preventDefault?.();
      applyQuery(query.slice(0, -1));
      return;
    }
    const character = printableChar(key);
    if (character === undefined) return;
    key.preventDefault?.();
    applyQuery(`${query}${character}`);
  };
  if (renderer.keyInput.prependListener !== undefined) {
    renderer.keyInput.prependListener("keypress", onKey);
  } else {
    renderer.keyInput.on("keypress", onKey);
  }
  const onResize = (): void => {
    applyLayout();
  };
  renderer.on?.("resize", onResize);

  return () => {
    removeListener(select, mod.SelectRenderableEvents.SELECTION_CHANGED, onSelection);
    removeListener(renderer.keyInput, "keypress", onKey);
    renderer.off?.("resize", onResize);
  };
};
