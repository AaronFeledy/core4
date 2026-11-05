import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  PluginManifest,
  ServiceName,
} from "@lando/sdk/schema";
import {
  ConfigService,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as GlobalApp from "../../src/global-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";

/** Real contribution/configuration admission, with independent runtime evidence for fixture globals. */
export const makeGlobalAdmissionFixture = (options: {
  readonly directory: string;
  readonly template: AppPlan;
  readonly stateStore: StateStoreShape;
  readonly ids?: ReadonlyArray<string>;
}) => {
  const ids = options.ids ?? ["test"];
  const paths = makeLandoPaths({
    userDataRoot: options.directory,
    userConfRoot: join(options.directory, "conf"),
    userCacheRoot: join(options.directory, "cache"),
    env: {},
  });
  const root = AbsolutePath.make(paths.globalAppRoot);
  const module = join(options.directory, "global-services.mjs");
  writeFileSync(
    module,
    `import {Effect} from ${JSON.stringify(import.meta.resolve("effect"))};export default Effect.succeed({type:"compose",image:"alpine:3.22"});\n`,
  );
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/start-admission-fixture",
    version: "1.0.0",
    api: 4,
    contributes: { globalServices: ids.map((id) => ({ id, module, enabledByDefault: true })) },
  });
  const pluginRegistry = PluginRegistry.of({
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.die("Global fixture planner uses portable compose services."),
    loadServiceFeature: () => Effect.die("No fixture service feature."),
    loadAppFeature: () => Effect.die("No fixture app feature."),
  });
  const { identity: _identity, requires: _requires, events: _events, ...template } = options.template;
  const globalPlan: AppPlan & { readonly valueModel: 1 } = {
    ...template,
    valueModel: 1,
    id: AppId.make("global"),
    name: "global",
    slug: "global",
    root,
    router: { enabled: false },
    services: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          name: ServiceName.make(id),
          type: "compose",
          provider: template.provider,
          primary: false,
          artifact: { kind: "ref" as const, ref: "alpine:3.22" },
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata: template.metadata,
          extensions: {},
        },
      ]),
    ),
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
  };
  const config = Schema.decodeSync(GlobalConfig)({ ...paths.roots, defaultProviderId: template.provider });
  const dependencies = Layer.mergeAll(
    FileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
  );
  const layer = Layer.mergeAll(
    dependencies,
    Layer.effect(
      GlobalAppService,
      Effect.map(GlobalAppService, (service) => ({
        ...service,
        providerId: Effect.succeed(template.provider),
      })),
    ).pipe(Layer.provide(GlobalApp.layer.pipe(Layer.provide(dependencies)))),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.effect(
      StateStore,
      Effect.map(PrivateFileAccessService, (access) => {
        const disk = makeStateStore({ roots: paths.roots, privateFileAccess: access });
        return StateStore.of({
          ...options.stateStore,
          open: (spec) => (spec.root === "userConf" ? disk.open(spec) : options.stateStore.open(spec)),
        });
      }),
    ).pipe(Layer.provide(dependencies)),
  );
  const observed = new Map<string, ServiceRuntimeInfo>();
  let applied: AppPlan | undefined;
  const wrapProvider = (provider: RuntimeProviderShape): RuntimeProviderShape => ({
    ...provider,
    apply: (plan, applyOptions) =>
      plan.id !== "global"
        ? provider.apply(plan, applyOptions)
        : Effect.sync(() => {
            if (plan.root !== root || plan.provider !== template.provider)
              throw new Error("Fixture global apply has different ownership.");
            for (const service of Object.values(plan.services)) {
              if (!ids.includes(String(service.name)))
                throw new Error(`Unknown global fixture service ${service.name}`);
              observed.set(String(service.name), {
                app: plan.id,
                appRoot: root,
                service: service.name,
                providerId: plan.provider,
                containerId: `fixture-global-${service.name}`,
                status: "running",
                state: "running",
                lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10000)),
                publications: { status: "present", bindings: [] },
              });
            }
            applied = applyOptions.recordedPlan ?? plan;
            return { changed: true };
          }),
    inspect: (target) =>
      target.app !== "global"
        ? provider.inspect(target)
        : Effect.sync(() => {
            const row = observed.get(String(target.service));
            if (
              row === undefined ||
              (target.plan !== undefined &&
                (target.plan.root !== root || target.plan.provider !== template.provider))
            )
              throw new Error("Unapplied or differently owned fixture global inspect.");
            return row;
          }),
    list: (filter) =>
      provider
        .list(filter)
        .pipe(
          Effect.map((rows) => [
            ...rows.filter((row) => row.app !== "global"),
            ...[...observed.values()].filter((row) => filter?.app === undefined || row.app === filter.app),
          ]),
        ),
    exec: (target, command) =>
      target.app !== "global"
        ? provider.exec(target, command)
        : Effect.sync(() => {
            if (!observed.has(String(target.service))) throw new Error("Unapplied fixture global exec.");
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
  });
  return { layer, paths, root, globalPlan, pluginRegistry, wrapProvider, appliedPlan: () => applied };
};
