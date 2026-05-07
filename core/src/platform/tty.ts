/**
 * Terminal capability detection.
 *
 * Used by:
 *   - The `Renderer` selector: TTY/CI auto-detection chooses `json` for
 *     non-TTY/CI, default otherwise.
 *   - The `Logger` selector: Effect's `Logger.pretty` for TTY,
 *     `Logger.json` for non-TTY by default.
 *
 * Status: stub. Bun has built-in ANSI color and terminal detection, so
 * `chalk`/`kleur` are not needed.
 */

export interface TerminalCapabilities {
  readonly isTTY: boolean;
  readonly isCI: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly supportsColor: boolean;
  readonly colorDepth: 1 | 4 | 8 | 24;
  readonly supportsUnicode: boolean;
}

export const detectTerminal = (): TerminalCapabilities => {
  // TODO: use Bun's native terminal detection.
  throw new Error("detectTerminal: not yet implemented");
};
