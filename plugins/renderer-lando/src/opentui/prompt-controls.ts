import { truncateToWidth } from "../terminal-width.ts";
import {
  checkboxOption,
  checkedIndicesFromDefault,
  choiceDescription,
  choiceLabel,
  isYesDefault,
  readPromptType,
  selectedChoiceIndex,
} from "./prompt-choice.ts";
import type {
  KeyEventLike,
  OpenTuiModuleLike,
  PromptDriverRequestLike,
  RenderableLike,
  RendererLike,
  SelectOptionLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, noopDisposer, removeListener } from "./prompt-listeners.ts";

const panelWidth = (renderer: RendererLike): number => Math.max(24, Math.min(72, renderer.width - 2));

const fitTitle = (message: string, width: number): string => truncateToWidth(message, Math.max(4, width - 4));

const addPromptChrome = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  request: PromptDriverRequestLike,
): RenderableLike => {
  const panel = new mod.BoxRenderable(renderer, {
    id: `lando-prompt-${request.prompt.name}`,
    border: true,
    borderStyle: "rounded",
    borderColor: "#2dd4bf",
    title: fitTitle(request.prompt.message, panelWidth(renderer)),
    titleAlignment: "left",
    backgroundColor: "#07131a",
    padding: 1,
    flexDirection: "column",
    gap: 1,
    width: panelWidth(renderer),
  });
  if (request.issue !== undefined && request.issue.length > 0) {
    panel.add?.(
      new mod.TextRenderable(renderer, {
        id: "lando-prompt-issue",
        content: request.issue,
        fg: "#f59e0b",
        width: panelWidth(renderer) - 4,
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
  const input = new mod.InputRenderable(renderer, {
    id: "lando-prompt-input",
    width: Math.max(10, panelWidth(renderer) - 4),
    value: defaultRaw ?? "",
    placeholder: defaultRaw === undefined ? "Type an answer…" : `Default: ${defaultRaw}`,
    backgroundColor: "#0f172a",
    textColor: "#e5f9ff",
    cursorColor: "#22d3ee",
    focusedBackgroundColor: "#102033",
    focusedTextColor: "#ffffff",
    placeholderColor: "#64748b",
  });
  input.on(mod.InputRenderableEvents.ENTER, () => done(input.value));
  panel.add?.(input);
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
    backgroundColor: "#0f172a",
    textColor: "#e5f9ff",
    cursorColor: "#22d3ee",
    focusedBackgroundColor: "#102033",
    focusedTextColor: "#ffffff",
    placeholderColor: "#64748b",
    onSubmit: () => done(textarea.plainText),
  });
  panel.add?.(textarea);
  textarea.focus?.();
};

const addSelectControl = <R extends RendererLike>(
  mod: OpenTuiModuleLike<R>,
  renderer: R,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
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
    width: Math.max(10, panelWidth(renderer) - 4),
    height: Math.max(2, Math.min(maxRows, options.length * rowsPerOption + 1)),
    options,
    showDescription,
    selectedIndex: selectedChoiceIndex(choices, defaultRaw),
    backgroundColor: "#07131a",
    textColor: "#bae6fd",
    focusedBackgroundColor: "#07131a",
    focusedTextColor: "#e0f2fe",
    selectedBackgroundColor: "#0f766e",
    selectedTextColor: "#ffffff",
    descriptionColor: "#64748b",
    selectedDescriptionColor: "#ccfbf1",
    showScrollIndicator: true,
  });
  select.on(mod.SelectRenderableEvents.ITEM_SELECTED, (index: number) => done(String(index + 1)));
  panel.add?.(select);
  select.focus?.();
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
    backgroundColor: "#07131a",
    textColor: "#bae6fd",
    focusedBackgroundColor: "#07131a",
    focusedTextColor: "#e0f2fe",
    selectedBackgroundColor: "#0f766e",
    selectedTextColor: "#ffffff",
    showScrollIndicator: true,
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
    backgroundColor: "#07131a",
    textColor: "#bae6fd",
    focusedBackgroundColor: "#07131a",
    focusedTextColor: "#e0f2fe",
    selectedBackgroundColor: "#0f766e",
    selectedTextColor: "#ffffff",
    selectedDescriptionColor: "#ccfbf1",
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
    addSelectControl(mod, renderer, panel, request, done);
    return noopDisposer;
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
