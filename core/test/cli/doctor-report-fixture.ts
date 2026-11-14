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
import { collectDoctorReport } from "../../src/cli/commands/doctor-report";
import type { DoctorSection } from "../../src/cli/commands/doctor-sections";

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
