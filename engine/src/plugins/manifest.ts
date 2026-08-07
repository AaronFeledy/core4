/**
 * Plugin manifest schema and loader.
 *
 * The manifest is itself an Effect Schema. Validation runs **before any
 * plugin module is imported**. A plugin module returning an
 * Effect Layer is composed into `LandoRuntimeLive` at load time. A plugin
 * module returning a plain object is wrapped via `Layer.succeed`. A plugin
 * module that throws on load is reported as `PluginLoadError` and the
 * plugin is marked unhealthy; other plugins continue.
 */
export { PluginManifest } from "@lando/sdk/schema";
