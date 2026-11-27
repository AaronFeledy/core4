import { identityRedactor, resolveCommandCompletion } from "@lando/sdk/command-result";
import type {
  ConfigService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import * as StateStore from "@lando/state-store/service";
import { Context, Effect, Layer, Option } from "effect";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns";
import type { DoctorOptions } from "../../src/cli/commands/doctor-options";
import { doctorNdjsonReport } from "../../src/cli/commands/doctor-render-ndjson";
import {
  type DoctorReport,
  collectDoctorReport,
  doctorCompletion,
} from "../../src/cli/commands/doctor-report";
import type { DoctorSection } from "../../src/cli/commands/doctor-sections";
import { encodeNdjsonReportLines } from "../../src/cli/renderer-machine-output";

export const collectRuntimeDoctor = (options: DoctorOptions = {}, table?: ReadonlyArray<DoctorSection>) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.context<
      ConfigService | PathsService | PluginRegistry | RuntimeProviderRegistry
    >();
    const resolver = yield* Effect.serviceOption(HostDnsResolver);
    const support = yield* Layer.build(
      Layer.merge(
        StateStore.layer,
        Option.isSome(resolver) ? Layer.succeed(HostDnsResolver, resolver.value) : HostDnsResolver.layer,
      ),
    ).pipe(Effect.provide(runtime));
    const context = Context.merge(runtime, support);
    return yield* collectDoctorReport({
      options,
      contexts: { config: context, runtime: context },
      ...(table === undefined ? {} : { table }),
    });
  }).pipe(Effect.scoped);

/** The `--format=ndjson` lines of a report, unredacted, through the production report encoder. */
export const renderDoctorReportAsNdjson = (report: DoctorReport): string =>
  Effect.runSync(
    encodeNdjsonReportLines(doctorNdjsonReport, {
      command: "meta:doctor",
      redactor: identityRedactor,
      outcome: resolveCommandCompletion("meta:doctor", report, doctorCompletion),
    }),
  ).join("\n");
