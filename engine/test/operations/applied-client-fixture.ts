import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type CurrentExecutableAppPlan,
  GlobalConfig,
  PortNumber,
  ProviderId,
  type ServiceConnection,
  ServiceName,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  LandofileService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";
import { runEventToolingCommand } from "../../src/operations/event-tooling-command.ts";
import { runAppEvent } from "../../src/operations/events.ts";
import { runTooling } from "../../src/operations/tooling.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as Resolver from "../../src/services/environment-value-resolver.ts";
import * as Events from "../../src/services/event-service.ts";
import * as Secrets from "../../src/services/secret-store.ts";
import * as Tooling from "../../src/services/tooling-engine.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

export const connection = (reference: string, port: number): ServiceConnection => ({
  family: "postgres",
  port: PortNumber.make(port),
  creds: {
    user: `${reference}-user`,
    database: `${reference}-db`,
    password: { _tag: "SecretRef", reference },
  },
});

export const clientFactory: NonNullable<ServiceType["toolingForConnection"]> = (name, facts) => ({
  psql: {
    service: name,
    cmd: ["psql", "-p", String(facts.port), "-U", facts.creds.user, "-d", facts.creds.database],
    env: { PGPASSWORD: facts.creds.password },
  },
});

export const appliedClientFixture = (
  input: {
    readonly authored?: ToolingTaskShape;
    readonly applied?: "missing" | "historical" | "family" | "root" | "id" | "provider";
    readonly missingDesired?: boolean;
    readonly inherited?: { readonly plan: CurrentExecutableAppPlan; readonly serviceType: ServiceType };
  } = {},
) => {
  const calls: { readonly command: readonly string[]; readonly env?: Readonly<Record<string, string>> }[] =
    [];
  const selections: number[] = [];
  const appliedRef = "APPLIED";
  const desired = connection(input.missingDesired ? "MISSING" : "DESIRED", 6543);
  const appliedConnection = connection(appliedRef, 5433);
  const secretEnv: Record<string, string> = {
    LANDO_SECRET_APPLIED: "first-applied-value",
    LANDO_SECRET_DESIRED: "desired-value",
  };
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    source: "test",
    runtime: 4 as const,
  };
  const service = {
    name: ServiceName.make("database"),
    type: input.inherited?.serviceType.id ?? "postgres",
    provider: input.inherited?.plan.provider ?? ProviderId.make("test"),
    primary: true,
    environment: {},
    connection: desired,
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    extensions: {},
    metadata,
  };
  const base: CurrentExecutableAppPlan = input.inherited?.plan ?? {
    valueModel: 1,
    id: AppId.make("applied-client"),
    name: "applied-client",
    slug: "applied-client",
    root: AbsolutePath.make(process.cwd()),
    provider: service.provider,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata,
  };
  const generated = clientFactory(service.name, desired);
  const plan =
    input.inherited?.plan ??
    attachEffectiveTooling(withProjectEvents(base, { "pre-start": [{ task: "psql" }] }), generated, {
      psql: service.name,
    });
  const { connection: _connection, ...historical } = service;
  const applied: AppPlan = {
    ...base,
    id: input.applied === "id" ? AppId.make("other") : base.id,
    root: input.applied === "root" ? AbsolutePath.make("/other") : base.root,
    provider: input.applied === "provider" ? ProviderId.make("other") : base.provider,
    services: {
      [service.name]:
        input.applied === "historical"
          ? historical
          : {
              ...service,
              connection: { ...appliedConnection, family: input.applied === "family" ? "mysql" : "postgres" },
            },
    },
  };
  const provider = {
    ...TestRuntimeProvider,
    execStream: (_target: ExecTarget, spec: CommandSpec) => {
      calls.push({ command: spec.command, ...(spec.env === undefined ? {} : { env: spec.env }) });
      return Stream.make({ exitCode: 0 });
    },
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const redaction = Layer.succeed(RedactionService, makeRedactionService());
  const resolver = Resolver.layer.pipe(
    Layer.provideMerge(Layer.merge(redaction, Secrets.layerWith({ env: secretEnv }))),
  );
  const plugin = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (registry) =>
      PluginRegistry.of({
        ...registry,
        loadServiceType: () =>
          Effect.succeed(
            input.inherited?.serviceType ?? {
              id: "postgres",
              name: "postgres",
              base: "lando",
              schema: Schema.Unknown,
              toolingForConnection: clientFactory,
              resolve: () => Effect.die("not used"),
            },
          ),
      }),
    ),
  ).pipe(Layer.provide(Registry.layerWith({ bundled: false }, [])));
  const layer = Layer.mergeAll(
    resolver,
    plugin,
    Tooling.layer.pipe(Layer.provide(resolver)),
    Events.layer.pipe(Layer.provide(redaction)),
    PrivateFileAccessService.layer,
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: compileTestLandofile({
          name: base.name,
          toolingDefaults: {
            env: { KEEP: "{{ concat('current-', vars.suffix) }}" },
            vars: { suffix: "default" },
          },
          ...(input.authored === undefined ? {} : { tooling: { psql: input.authored } }),
        }),
      }),
    ),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([base.provider]),
        capabilities: Effect.succeed(provider.capabilities),
        appliedPlansFor: () => Effect.succeed(input.applied === "missing" ? [] : [applied]),
        resolveAppliedPlan: () => Effect.succeed(applied),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        select: () =>
          Effect.sync(() => {
            selections.push(1);
            return provider;
          }),
      }),
    ),
  );
  return {
    calls,
    selections,
    plan,
    layer,
    secretEnv,
    run: () => Effect.runPromise(runTooling({ name: "psql" }).pipe(Effect.provide(layer), Effect.result)),
    event: () => Effect.runPromise(runAppEvent(plan, "pre-start").pipe(Effect.provide(layer), Effect.result)),
    command: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const task = generated.psql;
          if (task === undefined) return yield* Effect.die("missing fixture task");
          return yield* runEventToolingCommand(plan, "psql", task, []);
        }).pipe(Effect.provide(layer), Effect.result),
      ),
  };
};
