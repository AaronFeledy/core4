/**
 * Lando `Logger` service.
 *
 * The active logger is selected at bootstrap time:
 *
 *   - **CLI default:** Effect `Logger.pretty` for TTY, `Logger.json` for
 *     non-TTY (TTY/CI auto-detect via `../platform/tty.ts`).
 *   - **Library default:** `silent`.
 *
 * Plugins contribute renderers via `provides.loggers`. Selection by global
 * `logger:` config or `--logger=` flag.
 *
 * **Effect Logger as the logging contract:**
 * Core never calls `console.log` outside the renderer plugin. Inside Effect,
 * logs flow through `Effect.log*` and `Effect.annotateLogs`. The active
 * logger is an Effect `Logger` provided by a Layer; swapping it changes
 * how lines render. Plugins contribute renderers; the active renderer
 * chooses which Effect Logger configuration to install.
 */
export { Logger } from "@lando/sdk/services";
