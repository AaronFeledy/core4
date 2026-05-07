/**
 * `PluginRegistry` Live Layer.
 *
 * Discovery order:
 *   1. Bundled plugins (statically imported into the binary)
 *   2. System plugins (`<systemPluginRoot>/plugins/*`)
 *   3. User plugins (`<userConfRoot>/plugins/*`)
 *   4. App-local `pluginDirs:` (Landofile)
 *   5. Explicit Landofile `plugins:` (with source spec)
 *   6. Experimental plugins (when `experimental: true`)
 *
 * Library mode defaults all discovery sources to `false`.
 *
 * Status: stub.
 */
export { PluginRegistry } from "@lando/sdk/services";
