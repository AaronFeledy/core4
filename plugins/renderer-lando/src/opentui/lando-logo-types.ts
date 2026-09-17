/**
 * Structural seam over the OpenTUI surface the Lando logo needs. Like
 * `prompt-driver-types.ts`, it never names the OpenTUI package, so boundary
 * gates see no module edge; the host injects its already acquired module.
 */

/** OpenTUI box dimensions: cells, `auto`, or a percentage of the parent. */
export type LandoLogoDimension = number | "auto" | `${number}%`;

/** A resolved OpenTUI color; `indexed` intent keeps the terminal palette slot. */
export interface LandoLogoColorLike {
  readonly intent: "rgb" | "indexed" | "default";
  readonly slot: number;
}

export interface LandoLogoBufferLike {
  drawText(text: string, x: number, y: number, fg: LandoLogoColorLike): void;
}

/** The OpenTUI box the logo returns; `x`/`y` are absolute screen cells after layout. */
export interface LandoLogoRenderableLike {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  get width(): number;
  set width(value: LandoLogoDimension);
  get height(): number;
  set height(value: LandoLogoDimension);
  set padding(value: number | `${number}%` | null | undefined);
  add(child: unknown, index?: number): number;
  destroyRecursively(): void;
}

export interface LandoLogoBoxOptionsLike {
  readonly id?: string;
  readonly width?: LandoLogoDimension;
  readonly height?: LandoLogoDimension;
  readonly minWidth?: LandoLogoDimension;
  readonly minHeight?: LandoLogoDimension;
  readonly flexShrink?: number;
  readonly shouldFill?: boolean;
  /** OpenTUI's public paint hook, invoked with the box as `this` after its own paint. */
  readonly renderAfter?: (this: LandoLogoRenderableLike, buffer: LandoLogoBufferLike) => void;
}

/**
 * `Ctx` is the host's renderer type, so the seam never restates OpenTUI's
 * `RenderContext` surface (the same shape `prompt-driver-types.ts` uses).
 */
export interface LandoLogoModuleLike<Ctx> {
  readonly BoxRenderable: new (context: Ctx, options: LandoLogoBoxOptionsLike) => LandoLogoRenderableLike;
  readonly RGBA: { fromIndex(index: number): LandoLogoColorLike };
}
