import { truncateToWidth } from "../terminal-width.ts";
import { checkboxOption, checkedIndicesFromDefault, isYesDefault, readPromptType } from "./prompt-choice.ts";
import type {
  KeyEventLike,
  OpenTuiModuleLike,
  PromptDriverRequestLike,
  RenderableLike,
  RendererLike,
  SelectOptionLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, noopDisposer, removeListener } from "./prompt-listeners.ts";
import { addSelectControl, selectPanelMaxCols } from "./prompt-select-control.ts";
import { PROMPT_THEME, promptSelectColors } from "./prompt-theme.ts";

const panelWidth = (renderer: RendererLike, maxCols = 72): number =>
  Math.max(24, Math.min(maxCols, renderer.width - 2));

const fitTitle = (message: string, width: number): string => truncateToWidth(message, Math.max(4, width - 4));

const addPromptChrome = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  request: PromptDriverRequestLike,
): RenderableLike => {
  const type = readPromptType(request);
  const width = panelWidth(renderer, type === "select" ? selectPanelMaxCols(request) : 72);
  const panel = new mod.BoxRenderable(renderer, {
    id: `lando-prompt-${request.prompt.name}`,
    border: true,
    borderStyle: "rounded",
    borderColor: PROMPT_THEME.accent,
    title: fitTitle(request.prompt.message, width),
    titleAlignment: "left",
    backgroundColor: PROMPT_THEME.background,
    padding: 1,
    flexDirection: "column",
    gap: 1,
    width,
  });
  if (request.issue !== undefined && request.issue.length > 0) {
    panel.add?.(
      new mod.TextRenderable(renderer, {
        id: "lando-prompt-issue",
        content: request.issue,
        fg: PROMPT_THEME.issue,
        width: width - 4,
      }),
    );
  }
  renderer.root.add?.(panel);
  return panel;
};

const addInputControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
  const defaultRaw =
    request.defaultRaw ?? (request.prompt.default === undefined ? undefined : String(request.prompt.default));
  const width = Math.max(10, panelWidth(renderer) - 4);
  const input = new mod.InputRenderable(renderer, {
    id: "lando-prompt-input",
    width,
    value: defaultRaw ?? "",
    placeholder: defaultRaw === undefined ? "Type an answer…" : `Default: ${defaultRaw}`,
    backgroundColor: PROMPT_THEME.inputBackground,
    textColor: PROMPT_THEME.text,
    cursorColor: PROMPT_THEME.accent,
    focusedBackgroundColor: PROMPT_THEME.inputFocusedBackground,
    focusedTextColor: PROMPT_THEME.focusedText,
    placeholderColor: PROMPT_THEME.placeholder,
  });
  input.on(mod.InputRenderableEvents.ENTER, () => done(input.value));
  panel.add?.(input);
  if (defaultRaw !== undefined && defaultRaw.length > 0) {
    panel.add?.(
      new mod.TextRenderable(renderer, {
        id: "lando-prompt-default-hint",
        content: `Leave blank to use ${defaultRaw}`,
        fg: PROMPT_THEME.muted,
        width,
      }),
    );
  }
  input.focus?.();
};

const addTextareaControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
  const defaultRaw =
    request.defaultRaw ?? (request.prompt.default === undefined ? undefined : String(request.prompt.default));
  const textarea = new mod.TextareaRenderable(renderer, {
    id: "lando-prompt-textarea",
    width: Math.max(10, panelWidth(renderer) - 4),
    height: Math.max(3, Math.min(8, renderer.height - 6)),
    initialValue: defaultRaw ?? "",
    placeholder: defaultRaw === undefined ? "Type an answer…" : `Default: ${defaultRaw}`,
    backgroundColor: PROMPT_THEME.inputBackground,
    textColor: PROMPT_THEME.text,
    cursorColor: PROMPT_THEME.accent,
    focusedBackgroundColor: PROMPT_THEME.inputFocusedBackground,
    focusedTextColor: PROMPT_THEME.focusedText,
    placeholderColor: PROMPT_THEME.placeholder,
    onSubmit: () => done(textarea.plainText),
  });
  panel.add?.(textarea);
  textarea.focus?.();
};

const addMultiselectControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): PromptDisposer => {
  const choices = request.choices ?? request.prompt.choices ?? [];
  const checked = checkedIndicesFromDefault(choices, request.defaultRaw);
  const buildOptions = (): SelectOptionLike[] =>
    choices.map((choice, index) => checkboxOption(choice, index, checked.has(index)));
  const maxRows = Math.max(2, renderer.height - 6);
  const select = new mod.SelectRenderable(renderer, {
    id: "lando-prompt-multiselect",
    width: Math.max(10, panelWidth(renderer) - 4),
    height: Math.max(2, Math.min(maxRows, choices.length + 1)),
    options: buildOptions(),
    showDescription: false,
    selectedIndex: 0,
    ...promptSelectColors,
    showScrollIndicator: false,
  });
  // Space is not a SelectRenderable binding, so toggle the focused row's checked state here without submitting.
  const toggleListener = (key: KeyEventLike): void => {
    if (key.name !== "space") return;
    const focused = select.getSelectedIndex();
    if (checked.has(focused)) checked.delete(focused);
    else checked.add(focused);
    select.options = buildOptions();
    renderer.requestRender?.();
  };
  renderer.keyInput.on("keypress", toggleListener);
  select.on(mod.SelectRenderableEvents.ITEM_SELECTED, () => {
    const ascending = [...checked].sort((left, right) => left - right).map((index) => String(index + 1));
    done(ascending.join(","));
  });
  panel.add?.(select);
  select.focus?.();
  return () => removeListener(renderer.keyInput, "keypress", toggleListener);
};

const addConfirmControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
  const tabs = new mod.TabSelectRenderable(renderer, {
    id: "lando-prompt-confirm",
    width: Math.max(18, Math.min(30, panelWidth(renderer) - 4)),
    options: [
      { name: "Yes", description: "y" },
      { name: "No", description: "n" },
    ],
    tabWidth: 10,
    ...promptSelectColors,
    showDescription: false,
    showUnderline: true,
    wrapSelection: true,
  });
  tabs.setSelectedIndex?.(isYesDefault(request.defaultRaw) ? 0 : 1);
  tabs.on(mod.TabSelectRenderableEvents.ITEM_SELECTED, (index: number) => done(index === 0 ? "y" : "n"));
  panel.add?.(tabs);
  tabs.focus?.();
};

export const buildPrompt = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): PromptDisposer => {
  const type = readPromptType(request);
  const panel = addPromptChrome(mod, renderer, request);
  if (type === "select") {
    return addSelectControl(mod, renderer, panel, request, done);
  }
  if (type === "multiselect") {
    return addMultiselectControl(mod, renderer, panel, request, done);
  }
  if (type === "confirm") {
    addConfirmControl(mod, renderer, panel, request, done);
    return noopDisposer;
  }
  if (type === "textarea") {
    addTextareaControl(mod, renderer, panel, request, done);
    return noopDisposer;
  }
  addInputControl(mod, renderer, panel, request, done);
  return noopDisposer;
};
