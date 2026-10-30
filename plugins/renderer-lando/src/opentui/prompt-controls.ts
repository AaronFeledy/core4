import { truncateToWidth } from "../terminal-width.ts";
import { checkboxOption, checkedIndicesFromDefault, isYesDefault, readPromptType } from "./prompt-choice.ts";
import type {
  KeyEventLike,
  PromptDriverRequestLike,
  RenderableLike,
  RendererLike,
  SelectOptionLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, noopDisposer, removeListener } from "./prompt-listeners.ts";
import { addSelectControl, selectPanelMaxCols } from "./prompt-select-control.ts";
import { type PromptModuleLike, promptSelectColors } from "./prompt-theme.ts";

const panelWidth = (renderer: RendererLike, maxCols = 72): number =>
  Math.max(24, Math.min(maxCols, renderer.width - 2));

const fitTitle = (message: string, width: number): string => truncateToWidth(message, Math.max(4, width - 4));

const addPromptChrome = <R extends RendererLike>(
  mod: PromptModuleLike<R>,
  renderer: R,
  request: PromptDriverRequestLike,
): RenderableLike => {
  const type = readPromptType(request);
  const width = panelWidth(renderer, type === "select" ? selectPanelMaxCols(request) : 72);
  const panel = new mod.BoxRenderable(renderer, {
    id: `lando-prompt-${request.prompt.name}`,
    border: true,
    borderStyle: "rounded",
    borderColor: mod.theme.accent,
    title: fitTitle(request.prompt.message, width),
    titleAlignment: "left",
    backgroundColor: mod.theme.background,
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
        fg: mod.theme.issue,
        width: width - 4,
      }),
    );
  }
  renderer.root.add?.(panel);
  return panel;
};

const addInputControl = <R extends RendererLike>(
  mod: PromptModuleLike<R>,
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
    backgroundColor: mod.theme.inputBackground,
    textColor: mod.theme.text,
    cursorColor: mod.theme.accent,
    focusedBackgroundColor: mod.theme.inputFocusedBackground,
    focusedTextColor: mod.theme.focusedText,
    placeholderColor: mod.theme.placeholder,
  });
  input.on(mod.InputRenderableEvents.ENTER, () => done(input.value));
  panel.add?.(input);
  if (request.help !== undefined && request.help.length > 0) {
    panel.add?.(
      new mod.TextRenderable(renderer, {
        id: "lando-prompt-help",
        content: request.help,
        fg: mod.theme.muted,
        width,
      }),
    );
  }
  const footerLines = request.footer ?? [];
  const footerRenderables = footerLines.map((line) => {
    const node = new mod.TextRenderable(renderer, {
      id: `lando-prompt-footer-${line.id}`,
      content: line.render(input.value),
      fg: mod.theme.muted,
      width,
    });
    panel.add?.(node);
    return { line, node };
  });
  if (footerRenderables.length > 0) {
    input.on(mod.InputRenderableEvents.INPUT, (value: string) => {
      for (const footer of footerRenderables) {
        footer.node.content = footer.line.render(value);
      }
      renderer.requestRender?.();
    });
  }
  input.focus?.();
  if (defaultRaw !== undefined && defaultRaw.length > 0) {
    input.selectAll?.();
  }
};

const addTextareaControl = <R extends RendererLike>(
  mod: PromptModuleLike<R>,
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
    backgroundColor: mod.theme.inputBackground,
    textColor: mod.theme.text,
    cursorColor: mod.theme.accent,
    focusedBackgroundColor: mod.theme.inputFocusedBackground,
    focusedTextColor: mod.theme.focusedText,
    placeholderColor: mod.theme.placeholder,
    onSubmit: () => done(textarea.plainText),
  });
  panel.add?.(textarea);
  textarea.focus?.();
};

const addMultiselectControl = <R extends RendererLike>(
  mod: PromptModuleLike<R>,
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
    ...promptSelectColors(mod.theme),
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
  mod: PromptModuleLike<R>,
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
    ...promptSelectColors(mod.theme),
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
  mod: PromptModuleLike<R>,
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
