import { ansiToNativeStyledText } from "./ansi-styled-text.ts";
import type { NativeStyledTextModuleLike } from "./ansi-styled-text.ts";
import type { LiveRegionRenderableLike, OpenTuiLiveRegionModuleLike } from "./live-region-types.ts";

export type ReplayLine = ReturnType<typeof ansiToNativeStyledText>;

type ReplayRenderContext = {
  readonly width: number;
  readonly renderContext: unknown;
};

export const replaySnapshot = (
  module: OpenTuiLiveRegionModuleLike,
  context: ReplayRenderContext,
  line: ReplayLine,
): {
  readonly root: LiveRegionRenderableLike;
  readonly width: number;
  readonly startOnNewLine: true;
  readonly trailingNewline: true;
} => ({
  root: new module.TextRenderable(context.renderContext, { content: line, width: context.width }),
  width: context.width,
  startOnNewLine: true,
  trailingNewline: true,
});

export class LiveRegionReplay {
  private lines: ReplayLine[] = [];

  constructor(
    private readonly module: NativeStyledTextModuleLike,
    private width: number,
    private rowCapacity: number,
  ) {}

  line(text: string): ReplayLine {
    return ansiToNativeStyledText(this.module, text);
  }

  push(line: ReplayLine): void {
    this.lines.push(line);
    this.trim();
  }

  resize(width: number, rowCapacity: number): void {
    this.width = width;
    this.rowCapacity = rowCapacity;
    this.trim();
  }

  retainedLines(): ReadonlyArray<ReplayLine> {
    return this.lines;
  }

  private visibleText(line: ReplayLine): string {
    return line.chunks.map((chunk) => chunk.text).join("");
  }

  private visibleRows(line: ReplayLine): number {
    return Math.max(1, Math.ceil(Bun.stringWidth(this.visibleText(line)) / Math.max(1, this.width)));
  }

  private trim(): void {
    let remainingRows = this.rowCapacity;
    const retained: ReplayLine[] = [];
    for (let index = this.lines.length - 1; index >= 0 && remainingRows > 0; index -= 1) {
      const line = this.lines[index];
      if (line === undefined) continue;
      const rows = this.visibleRows(line);
      if (rows <= remainingRows) {
        retained.unshift(line);
        remainingRows -= rows;
        continue;
      }
      const cellCapacity = remainingRows * Math.max(1, this.width);
      const suffixCharacters: string[] = [];
      let suffixCells = 0;
      for (const character of Array.from(this.visibleText(line)).reverse()) {
        if (suffixCharacters.length >= cellCapacity) break;
        const characterCells = Bun.stringWidth(character);
        if (suffixCells + characterCells > cellCapacity) break;
        suffixCharacters.push(character);
        suffixCells += characterCells;
      }
      retained.unshift(this.line(suffixCharacters.reverse().join("")));
      remainingRows = 0;
    }
    this.lines = retained;
  }
}
