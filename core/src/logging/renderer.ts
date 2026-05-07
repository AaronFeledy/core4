/**
 * `Renderer` service contract.
 *
 * Renderers are plugin-contributed output strategies.
 *
 * Built-in render events:
 *   - `task.start`, `task.progress`, `task.complete`, `task.fail`
 *   - `log.line`
 *   - `message.info`, `message.warn`, `message.error`
 *   - `table.row`, `table.end`
 *   - `prompt.start`, `prompt.complete`
 *
 * Default renderer is the Lando renderer (interactive, colorful,
 * listr-style). Plugins may ship `json`, `plain`, `verbose`.
 *
 * Renderer selection: `--renderer=` → `LANDO_RENDERER` → global `renderer:`
 * → TTY/CI auto-detection (`json` for non-TTY/CI, default otherwise).
 */
export { Renderer } from "@lando/sdk/services";
