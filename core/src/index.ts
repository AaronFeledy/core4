/**
 * `@lando/core` — public library API entry point.
 *
 * Public API surface for the `LandoRuntime` factory.
 *
 * **Stability:** this Alpha library surface is unstable and published only on
 * dev/next channels until v4.0.0 GA. New exports require a library-API
 * contract test under `test/library/`.
 *
 * **Boundary rule:** importing this entry point MUST NOT pull `@oclif/core`
 * into the import graph. An embedding host that never invokes the CLI must
 * not pay for OCLIF in its bundle. Enforced by the import-boundary test
 * under `test/library/`.
 */

// Runtime factory.
export { makeLandoRuntime, type LandoRuntimeOptions } from "./runtime/layer.ts";
export type { BootstrapLevel } from "./runtime/bootstrap.ts";

// Re-export the most commonly-used Effect Service tags so consumers get them
// without an extra import (`@lando/core/services` exports the full set).
export {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  EventService,
  FileSystem,
  LandofileService,
  Logger,
  PluginRegistry,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  Telemetry,
} from "@lando/sdk/services";
