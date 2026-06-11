/**
 * `@lando/core` — public library API entry point.
 *
 * Public API surface for the `LandoRuntime` factory.
 *
 * **Stability:** this library surface is unstable and published only on
 * dev/next channels until GA. New exports require a library-API
 * contract test.
 *
 * **Boundary rule:** importing this entry point MUST NOT pull `@oclif/core`
 * into the import graph. An embedding host that never invokes the CLI must
 * not pay for OCLIF in its bundle. Enforced by the library import-boundary test.
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
  DeprecationService,
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
