import { choiceDescription, choiceLabel, selectedChoiceIndex } from "./prompt-choice.ts";
import type {
  OpenTuiModuleLike,
  PromptDriverRequestLike,
  RenderableLike,
  RendererLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, noopDisposer } from "./prompt-listeners.ts";
import { addDescribedSelect } from "./prompt-select-described.ts";
import { promptSelectColors } from "./prompt-theme.ts";
import { SELECT_PREVIEW_LAYOUT } from "./select-preview-layout.ts";

export const hasDescribedChoices = (choices: ReadonlyArray<unknown>): boolean =>
  choices.some((choice) => (choiceDescription(choice) ?? "").trim() !== "");

export const selectPanelMaxCols = (request: PromptDriverRequestLike): number =>
  hasDescribedChoices(request.choices ?? request.prompt.choices ?? [])
    ? SELECT_PREVIEW_LAYOUT.PANEL_MAX
    : 72;

const addPlainSelect = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): PromptDisposer => {
  const choices = request.choices ?? request.prompt.choices ?? [];
  const defaultRaw =
    request.defaultRaw ?? (request.prompt.default === undefined ? undefined : String(request.prompt.default));
  const options = choices.map((choice, index) => ({
    name: choiceLabel(choice),
    description: choiceDescription(choice) ?? "",
    value: String(index + 1),
  }));
  const showDescription = choices.some((choice) => choiceDescription(choice) !== undefined);
  const rowsPerOption = showDescription ? 2 : 1;
  const maxRows = Math.max(2, renderer.height - 6);
  const select = new mod.SelectRenderable(renderer, {
    id: "lando-prompt-select",
    width: Math.max(10, Math.min(72, renderer.width - 2) - 4),
    height: Math.max(2, Math.min(maxRows, options.length * rowsPerOption + 1)),
    options,
    showDescription,
    selectedIndex: selectedChoiceIndex(choices, defaultRaw),
    ...promptSelectColors,
    showScrollIndicator: false,
  });
  select.on(mod.SelectRenderableEvents.ITEM_SELECTED, (index: number) => done(String(index + 1)));
  panel.add?.(select);
  select.focus?.();
  return noopDisposer;
};

export const addSelectControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): PromptDisposer => {
  const choices = request.choices ?? request.prompt.choices ?? [];
  if (hasDescribedChoices(choices)) return addDescribedSelect(mod, renderer, panel, request, done);
  return addPlainSelect(mod, renderer, panel, request, done);
};
