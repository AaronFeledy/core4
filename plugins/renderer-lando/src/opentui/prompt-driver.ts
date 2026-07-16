interface PromptSpecLike {
  name: string;
  type: string;
  message: string;
  default?: unknown;
  choices?: ReadonlyArray<unknown>;
  validate?: unknown;
}

interface PromptDriverRequestLike {
  prompt: PromptSpecLike;
  mode: "normal" | "manual-choice" | "confirm";
  defaultRaw?: string;
  issue?: string;
  choices?: ReadonlyArray<unknown>;
}

interface KeyEventLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

type EventListenerLike = (...args: ReadonlyArray<never>) => void;

interface EventEmitterLike {
  on(event: string, listener: EventListenerLike): unknown;
  off?(event: string, listener: EventListenerLike): unknown;
  removeListener?(event: string, listener: EventListenerLike): unknown;
}

interface RenderableLike extends EventEmitterLike {
  add?(child: RenderableLike): unknown;
  focus?(): unknown;
  destroy?(): unknown;
}

interface InputRenderableLike extends RenderableLike {
  value: string;
}

interface TextareaRenderableLike extends RenderableLike {
  plainText: string;
  onSubmit?: () => void;
}

interface SelectRenderableLike extends RenderableLike {
  setSelectedIndex?(index: number): unknown;
}

export interface RendererLike {
  root: RenderableLike;
  keyInput: EventEmitterLike;
  width: number;
  height: number;
  start?(): unknown;
  requestRender?(): unknown;
  destroy(): unknown | Promise<unknown>;
}

interface ConstructorLike<T> {
  new (renderer: RendererLike, options: Record<string, unknown>): T;
}

export interface OpenTuiModuleLike {
  createCliRenderer(config: Record<string, unknown>): Promise<RendererLike>;
  BoxRenderable: ConstructorLike<RenderableLike>;
  TextRenderable: ConstructorLike<RenderableLike>;
  InputRenderable: ConstructorLike<InputRenderableLike>;
  TextareaRenderable: ConstructorLike<TextareaRenderableLike>;
  SelectRenderable: ConstructorLike<SelectRenderableLike>;
  TabSelectRenderable: ConstructorLike<SelectRenderableLike>;
  InputRenderableEvents: { ENTER: string };
  SelectRenderableEvents: { ITEM_SELECTED: string };
  TabSelectRenderableEvents: { ITEM_SELECTED: string };
}

export interface OpenTuiPromptDriverDeps {
  loadModule?: () => Promise<OpenTuiModuleLike>;
  createRenderer?: (mod: OpenTuiModuleLike) => Promise<RendererLike>;
  /** Production starts the live paint loop; test harness drives frames manually so it injects a no-op. */
  startRenderer?: (renderer: RendererLike) => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

const loadOpenTuiModule = async (): Promise<OpenTuiModuleLike> => {
  const mod: unknown = await import("@opentui/core");
  return mod as OpenTuiModuleLike;
};

const makeUnavailableError = (cause?: unknown): Error => {
  const error = new Error("OpenTUI prompt driver is unavailable for this process.", { cause });
  error.name = "OpenTuiPromptUnavailableError";
  return error;
};

const makePromptCancelledError = (): Error => {
  const error = new Error("Prompt cancelled");
  error.name = "PromptCancelledError";
  return error;
};

const isCancellationKey = (key: KeyEventLike): boolean =>
  key.name === "escape" || (key.ctrl === true && key.name === "c") || key.sequence === "\u0003";

const removeListener = (emitter: EventEmitterLike, event: string, listener: EventListenerLike): void => {
  if (emitter.off !== undefined) {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
};

const choiceValue = (choice: unknown): unknown => {
  if (choice !== null && typeof choice === "object" && "value" in choice) {
    return (choice as { value?: unknown }).value;
  }
  return choice;
};

const choiceLabel = (choice: unknown): string => {
  if (choice !== null && typeof choice === "object") {
    const record = choice as { label?: unknown; name?: unknown; value?: unknown; description?: unknown };
    const candidate = record.label ?? record.name ?? record.value;
    return String(candidate ?? "");
  }
  return String(choice);
};

const choiceDescription = (choice: unknown): string | undefined => {
  if (choice !== null && typeof choice === "object") {
    const description = (choice as { description?: unknown }).description;
    return description === undefined ? undefined : String(description);
  }
  return undefined;
};

const matchesDefault = (choice: unknown, defaultRaw: string): boolean =>
  String(choiceValue(choice)) === defaultRaw || choiceLabel(choice) === defaultRaw;

const selectedChoiceIndex = (choices: ReadonlyArray<unknown>, defaultRaw: string | undefined): number => {
  if (defaultRaw === undefined) return 0;
  const index = choices.findIndex((choice) => matchesDefault(choice, defaultRaw));
  return index >= 0 ? index : 0;
};

const isYesDefault = (defaultRaw: string | undefined): boolean =>
  defaultRaw !== undefined && /^(y|yes|true|1|on)$/i.test(defaultRaw.trim());

const isDeclinedType = (type: string): boolean => type === "secret" || type === "multiselect";

const readPromptType = (request: PromptDriverRequestLike): string => {
  if (request.mode === "confirm") return "confirm";
  if (request.mode === "manual-choice") return "manual-choice";
  return request.prompt.type;
};

const panelWidth = (renderer: RendererLike): number => Math.max(24, Math.min(72, renderer.width - 2));

const addPromptChrome = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
  request: PromptDriverRequestLike,
): RenderableLike => {
  const panel = new mod.BoxRenderable(renderer, {
    id: `lando-prompt-${request.prompt.name}`,
    border: true,
    borderStyle: "rounded",
    borderColor: "#2dd4bf",
    backgroundColor: "#07131a",
    padding: 1,
    flexDirection: "column",
    gap: 1,
    width: panelWidth(renderer),
  });
  panel.add?.(
    new mod.TextRenderable(renderer, {
      id: "lando-prompt-message",
      content: request.prompt.message,
      fg: "#7dd3fc",
      width: panelWidth(renderer) - 4,
    }),
  );
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

const addInputControl = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
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

const addTextareaControl = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
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

const addSelectControl = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
  panel: RenderableLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
  const choices = request.choices ?? request.prompt.choices ?? [];
  const defaultRaw =
    request.defaultRaw ?? (request.prompt.default === undefined ? undefined : String(request.prompt.default));
  const options = choices.map((choice, index) => ({
    name: choiceLabel(choice),
    description: choiceDescription(choice) ?? String(index + 1),
    value: String(index + 1),
  }));
  const select = new mod.SelectRenderable(renderer, {
    id: "lando-prompt-select",
    width: Math.max(10, panelWidth(renderer) - 4),
    height: Math.max(3, Math.min(8, options.length + 1)),
    options,
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

const addConfirmControl = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
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

const buildPrompt = (
  mod: OpenTuiModuleLike,
  renderer: RendererLike,
  request: PromptDriverRequestLike,
  done: (value: string) => void,
): void => {
  const type = readPromptType(request);
  const panel = addPromptChrome(mod, renderer, request);
  if (type === "select") {
    addSelectControl(mod, renderer, panel, request, done);
    return;
  }
  if (type === "confirm") {
    addConfirmControl(mod, renderer, panel, request, done);
    return;
  }
  if (type === "textarea") {
    addTextareaControl(mod, renderer, panel, request, done);
    return;
  }
  addInputControl(mod, renderer, panel, request, done);
};

export const createOpenTuiPromptDriver = (
  deps: OpenTuiPromptDriverDeps = {},
): { readRaw: (request: unknown) => Promise<string> } => {
  const loadModule = deps.loadModule ?? loadOpenTuiModule;
  const startRenderer =
    deps.startRenderer ??
    ((renderer: RendererLike): void => {
      renderer.start?.();
    });
  let openTuiAvailable = true;
  return {
    readRaw: async (request: unknown): Promise<string> => {
      const typedRequest = request as PromptDriverRequestLike;
      const type = readPromptType(typedRequest);
      if (isDeclinedType(type)) throw new Error(`driver declines ${type}`);
      if (!openTuiAvailable) throw makeUnavailableError();

      let mod: OpenTuiModuleLike;
      let renderer: RendererLike;
      try {
        mod = await loadModule();
        renderer = await (deps.createRenderer?.(mod) ??
          mod.createCliRenderer({
            stdin: deps.stdin,
            stdout: deps.stdout,
            exitOnCtrlC: false,
            screenMode: "main-screen",
            useMouse: false,
            targetFps: 30,
          }));
      } catch (cause) {
        openTuiAvailable = false;
        throw makeUnavailableError(
          cause instanceof Error
            ? cause
            : new Error("OpenTUI initialization failed with a non-Error cause.", { cause }),
        );
      }

      let cancelListener: ((key: KeyEventLike) => void) | undefined;
      try {
        try {
          startRenderer(renderer);
        } catch (cause) {
          openTuiAvailable = false;
          throw makeUnavailableError(
            cause instanceof Error
              ? cause
              : new Error("OpenTUI startup failed with a non-Error cause.", { cause }),
          );
        }
        return await new Promise<string>((resolve, reject) => {
          let settled = false;
          const settle = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            callback();
          };
          const done = (value: string): void => settle(() => resolve(value));
          cancelListener = (key: KeyEventLike): void => {
            if (isCancellationKey(key)) settle(() => reject(makePromptCancelledError()));
          };
          renderer.keyInput.on("keypress", cancelListener);
          buildPrompt(mod, renderer, typedRequest, done);
          renderer.requestRender?.();
        });
      } finally {
        if (cancelListener !== undefined) removeListener(renderer.keyInput, "keypress", cancelListener);
        await renderer.destroy();
      }
    },
  };
};
