/**
 * Built-in `PluginSource` adapters.
 *
 * Built-in sources:
 *   - `registry` — Bun-driven `bun add` semantics
 *   - `git` — git URL or shorthand (`git+https://...`, `gh:user/repo`)
 *   - `local` — `file:` directory
 *   - `tarball` — remote `https://...` archive
 *
 * Status: stub. Source adapters land alongside `lando plugin:add`.
 */
export { PluginSource } from "@lando/sdk/services";
