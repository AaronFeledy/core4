export interface PromptSpecLike {
  name: string;
  type: string;
  message: string;
  default?: unknown;
  choices?: ReadonlyArray<unknown>;
  validate?: unknown;
}

export interface PromptDriverRequestLike {
  prompt: PromptSpecLike;
  mode: "normal" | "manual-choice" | "confirm";
  defaultRaw?: string;
  issue?: string;
  choices?: ReadonlyArray<unknown>;
}

export interface KeyEventLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

/**
 * Structural listener whose argument tuple is inferred per call. Generic over
 * the tuple so a specific handler (`(index: number) => void`) fits the emitter
 * seam while OpenTUI's own `(...args: any[]) => void` emitter stays assignable.
 */
export type EventListenerLike<A extends ReadonlyArray<unknown>> = (...args: A) => void;

export interface EventEmitterLike {
  on<A extends ReadonlyArray<unknown>>(event: string, listener: EventListenerLike<A>): unknown;
  off?<A extends ReadonlyArray<unknown>>(event: string, listener: EventListenerLike<A>): unknown;
  removeListener?<A extends ReadonlyArray<unknown>>(event: string, listener: EventListenerLike<A>): unknown;
}

export interface RenderableLike extends EventEmitterLike {
  add?(child: unknown): unknown;
  focus?(): unknown;
  destroy?(): unknown;
}

export interface InputRenderableLike extends RenderableLike {
  value: string;
}

export interface TextareaRenderableLike extends RenderableLike {
  plainText: string;
}

export interface SelectOptionLike {
  name: string;
  description: string;
  value?: unknown;
}

export interface SelectRenderableLike extends RenderableLike {
  options: SelectOptionLike[];
  getSelectedIndex(): number;
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

/**
 * OpenTUI renderables are constructed with the concrete renderer context `Ctx`
 * (`CliRenderer implements RenderContext`); `Ctx` is a type parameter so the
 * seam never restates OpenTUI's `RenderContext` surface.
 */
interface ConstructorLike<Ctx, T> {
  new (renderer: Ctx, options: object): T;
}

export interface OpenTuiModuleLike<R extends RendererLike = RendererLike> {
  createCliRenderer(config: object): Promise<R>;
  BoxRenderable: ConstructorLike<R, RenderableLike>;
  TextRenderable: ConstructorLike<R, RenderableLike>;
  InputRenderable: ConstructorLike<R, InputRenderableLike>;
  TextareaRenderable: ConstructorLike<R, TextareaRenderableLike>;
  SelectRenderable: ConstructorLike<R, SelectRenderableLike>;
  TabSelectRenderable: ConstructorLike<R, SelectRenderableLike>;
  InputRenderableEvents: { ENTER: string };
  SelectRenderableEvents: { ITEM_SELECTED: string };
  TabSelectRenderableEvents: { ITEM_SELECTED: string };
}

export interface OpenTuiPromptDriverDeps<R extends RendererLike = RendererLike> {
  loadModule?: () => Promise<OpenTuiModuleLike<R>>;
  createRenderer?: (mod: OpenTuiModuleLike<R>) => Promise<R>;
  /** Production starts the live paint loop; test harness drives frames manually so it injects a no-op. */
  startRenderer?: (renderer: R) => void;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}
