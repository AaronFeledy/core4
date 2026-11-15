import type {
  ConfigService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { type DoctorOptions, doctor } from "./doctor";
import { acceleratedStartsDoctor } from "./doctor-accelerated-starts";
import { appConfigFindings, appConfigForReport } from "./doctor-app-config";
import { certsDoctorStatus, certsSubsystemCheck } from "./doctor-certs-status";
import type { DoctorSectionId, DoctorSectionResult } from "./doctor-contract";
import { debuggerHostDoctor } from "./doctor-debugger";
import { deprecationFindings, doctorDeprecations } from "./doctor-deprecations";
import { filesystemWatchDoctor } from "./doctor-filesystem-watch";
import { DefaultGlobalAppDoctorLayer, globalAppDoctor } from "./doctor-global-app";
import type { HostDnsResolver } from "./doctor-host-dns";
import { legacySnapshotCatalogsDoctor } from "./doctor-legacy-snapshot-catalogs";
import { listenerDoctorChecks } from "./doctor-listeners";
import { DefaultMcpDoctorLayer, mcpDoctor } from "./doctor-mcp";
import { missingAppRootsDoctor } from "./doctor-missing-app-roots";
import { networkTrustDoctorStatus } from "./doctor-network-trust";
import { orphanedSnapshotsDoctor } from "./doctor-orphaned-snapshots";
import { subsystemDoctor } from "./doctor-subsystems";
import { appVersionConstraintsForReport } from "./doctor-version-constraint";

export type DoctorConfigServices = ConfigService | PathsService | StateStore | HostDnsResolver;
export type DoctorRuntimeServices = DoctorConfigServices | RuntimeProviderRegistry | PluginRegistry;

export interface DoctorContexts {
  readonly config?: Context.Context<DoctorConfigServices>;
  readonly runtime?: Context.Context<DoctorRuntimeServices>;
}

interface DoctorSectionBase {
  readonly id: DoctorSectionId;
  readonly when?: (options: DoctorOptions) => boolean;
  /** Runs at its declared level but inspects more when the provider runtime is built. */
  readonly usesRuntime?: true;
}

export type DoctorSectionSpec<R> = DoctorSectionBase &
  (
    | { readonly run: Effect.Effect<DoctorSectionResult, unknown, R>; readonly isolate?: undefined }
    | { readonly run: Effect.Effect<DoctorSectionResult, never, R>; readonly isolate: false }
  );

export type DoctorSection =
  | (DoctorSectionSpec<never> & { readonly requires: "none" })
  | (DoctorSectionSpec<DoctorConfigServices> & { readonly requires: "config" })
  | (DoctorSectionSpec<DoctorRuntimeServices> & { readonly requires: "runtime" });

export const independentSection = (spec: DoctorSectionSpec<never>): DoctorSection => ({
  ...spec,
  requires: "none",
});
export const configSection = (spec: DoctorSectionSpec<DoctorConfigServices>): DoctorSection => ({
  ...spec,
  requires: "config",
});
export const runtimeSection = (spec: DoctorSectionSpec<DoctorRuntimeServices>): DoctorSection => ({
  ...spec,
  requires: "runtime",
});

/** Whether selecting this section should build the provider runtime. */
export const wantsDoctorRuntime = (section: DoctorSection): boolean =>
  section.requires === "runtime" || section.usesRuntime === true;

export const selectedDoctorSections = (table: ReadonlyArray<DoctorSection>, options: DoctorOptions) =>
  table.filter((section) =>
    options.sections === undefined
      ? section.when === undefined || section.when(options)
      : options.sections.includes(section.id),
  );

export const doctorSections = (input: {
  readonly options: DoctorOptions;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly budgetMs: number;
  readonly redact: (value: string) => string;
}): ReadonlyArray<DoctorSection> => {
  const { options, sourceEnv, budgetMs, redact } = input;
  return [
    runtimeSection({ id: "provider", run: doctor(options) }),
    runtimeSection({
      id: "app-listeners",
      when: (candidate) => candidate.app === true,
      isolate: false,
      run: listenerDoctorChecks({ budgetMs, redact }),
    }),
    runtimeSection({
      id: "certificate-authority",
      run: certsDoctorStatus(redact).pipe(
        Effect.flatMap((status) => certsSubsystemCheck(status, options.fix === true)),
        Effect.map((check): DoctorSectionResult => ({ checks: check === undefined ? [] : [check] })),
      ),
    }),
    configSection({
      id: "network-trust",
      run: networkTrustDoctorStatus(sourceEnv).pipe(
        Effect.map((status): DoctorSectionResult => ({ checks: [status] })),
      ),
    }),
    configSection({
      id: "subsystems",
      usesRuntime: true,
      run: subsystemDoctor({ fix: options.fix === true }),
    }),
    configSection({
      id: "global-app",
      run: globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer)),
    }),
    independentSection({ id: "mcp", run: mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer)) }),
    configSection({
      id: "accelerated-starts",
      run: acceleratedStartsDoctor(redact).pipe(Effect.map((checks): DoctorSectionResult => ({ checks }))),
    }),
    runtimeSection({
      id: "missing-app-roots",
      run: missingAppRootsDoctor(redact).pipe(Effect.map((checks): DoctorSectionResult => ({ checks }))),
    }),
    runtimeSection({
      id: "orphaned-volume-snapshots",
      run: orphanedSnapshotsDoctor(redact).pipe(Effect.map((checks): DoctorSectionResult => ({ checks }))),
    }),
    configSection({
      id: "legacy-snapshot-catalogs",
      run: legacySnapshotCatalogsDoctor(redact).pipe(
        Effect.map((checks): DoctorSectionResult => ({ checks })),
      ),
    }),
    independentSection({
      id: "filesystem-watch",
      run: filesystemWatchDoctor(redact, options.platform).pipe(
        Effect.map((checks): DoctorSectionResult => ({ checks })),
      ),
    }),
    configSection({ id: "debugger-host", run: debuggerHostDoctor(redact, budgetMs, options.platform) }),
    independentSection({
      id: "app-version-constraints",
      when: (candidate) => candidate.app === true,
      run: appVersionConstraintsForReport().pipe(Effect.map((result) => result ?? { checks: [] })),
    }),
    runtimeSection({
      id: "deprecations",
      when: (candidate) => candidate.deprecations === true,
      run: doctorDeprecations().pipe(
        Effect.map((report): DoctorSectionResult => ({ checks: deprecationFindings(report) })),
      ),
    }),
    runtimeSection({
      id: "app-config",
      when: (candidate) => candidate.app === true,
      run: appConfigForReport().pipe(
        Effect.map((result): DoctorSectionResult => ({ checks: appConfigFindings(result) })),
      ),
    }),
  ];
};
