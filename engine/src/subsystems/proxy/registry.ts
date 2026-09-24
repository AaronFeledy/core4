import { Context, Effect, Either, Layer, Schema } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { AbsolutePath, type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import {
  type CertificateAuthority,
  ConfigService,
  EventService,
  type FileSystem,
  type GlobalAppService,
  ManagedFileService,
  PathsService,
  type RouterService,
  StateStore,
} from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { bundledPluginModules } from "../../composition.ts";
import { makePublishRender } from "../../lifecycle/publish-render.ts";
import { makeLandoPluginContext } from "../../plugins/context.ts";
import { makePluginCapabilityIndex } from "../../plugins/module-set.ts";
import { RouterServiceUnavailableLive } from "./api.ts";
import { DeferredCertificateAuthorityLive } from "./deferred-certificate-authority.ts";

export type RouterServiceLayer = Layer.Layer<
  RouterService,
  ProxyError,
  CertificateAuthority | FileSystem | GlobalAppService | PathsService
>;

export interface RouterServiceRegistration {
  readonly id: string;
  readonly layer: RouterServiceLayer;
  readonly defaultFor?: {
    readonly platform?: ReadonlyArray<string> | undefined;
  };
}

export interface RouterServiceSelection {
  readonly explicit?: string;
}

interface RouterServiceRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<string>>;
  readonly select: (
    selection?: RouterServiceSelection,
  ) => Effect.Effect<RouterServiceRegistration, ProxyError>;
}

export class RouterServiceRegistry extends Context.Tag("@lando/core/RouterServiceRegistry")<
  RouterServiceRegistry,
  RouterServiceRegistryShape
>() {}

interface MakeRouterServiceRegistryOptions {
  readonly registrations: ReadonlyArray<RouterServiceRegistration>;
  readonly configured: Effect.Effect<string | undefined, ProxyError>;
  readonly platform: HostPlatform;
}

const selectionError = (message: string, proxyId: string): ProxyError =>
  new ProxyError({
    message,
    proxyId,
    remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
  });

export const makeRouterServiceRegistry = (
  options: MakeRouterServiceRegistryOptions,
): RouterServiceRegistryShape => {
  const byId = new Map(options.registrations.map((registration) => [registration.id, registration]));
  const selectId = (id: string): Effect.Effect<RouterServiceRegistration, ProxyError> => {
    const registration = byId.get(id);
    return registration === undefined
      ? Effect.fail(selectionError(`Router service ${id} is not installed.`, id))
      : Effect.succeed(registration);
  };

  return {
    list: Effect.succeed([...byId.keys()]),
    select: (selection = {}) =>
      Effect.gen(function* () {
        if (selection.explicit !== undefined) return yield* selectId(selection.explicit);

        const configured = yield* options.configured;
        if (configured !== undefined) return yield* selectId(configured);

        const defaults = options.registrations.filter((registration) =>
          registration.defaultFor?.platform?.includes(hostPlatformFamily(options.platform)),
        );
        const matchedDefault = defaults[0];
        if (defaults.length === 1 && matchedDefault !== undefined) return matchedDefault;
        const soleRegistration = options.registrations[0];
        if (options.registrations.length === 1 && soleRegistration !== undefined) return soleRegistration;

        return yield* Effect.fail(
          selectionError("No RouterService plugin could be selected unambiguously.", "unknown"),
        );
      }),
  };
};

const descriptorError = (cause: unknown): ProxyError =>
  new ProxyError({
    message: "Unable to discover RouterService contributions.",
    proxyId: "unknown",
    remediation:
      "Repair invalid plugin descriptors and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.",
    cause,
  });

const registrationsFromModules = (
  modules: ReadonlyArray<LandoPluginModule>,
  dependencies: {
    readonly paths: Context.Tag.Service<typeof PathsService>;
    readonly managedFileService: Context.Tag.Service<typeof ManagedFileService>;
    readonly stateStore: Context.Tag.Service<typeof StateStore>;
    readonly privateFileAccess: Context.Tag.Service<typeof PrivateFileAccessService>;
    readonly eventService?: Context.Tag.Service<typeof EventService>;
    readonly redaction?: Context.Tag.Service<typeof RedactionService>;
  },
): Effect.Effect<ReadonlyArray<RouterServiceRegistration>, ProxyError> =>
  Effect.gen(function* () {
    const indexResult = makePluginCapabilityIndex(modules);
    if (Either.isLeft(indexResult)) return yield* Effect.fail(descriptorError(indexResult.left));
    const index = indexResult.right;
    const contributions = index.manifests.flatMap((manifest) =>
      (manifest.contributes?.routerServices ?? []).map((contribution) => ({ contribution, manifest })),
    );
    return yield* Effect.forEach(contributions, ({ contribution, manifest }) => {
      const provided = index.routerServices.get(contribution.id);
      const module = modules.find((candidate) => String(candidate.manifest.name) === String(manifest.name));
      if (
        provided === undefined ||
        module === undefined ||
        module.routerServices?.get(contribution.id) !== provided
      ) {
        return Effect.fail(
          new ProxyError({
            message: `Router service descriptor does not export ${contribution.id}.`,
            proxyId: contribution.id,
            remediation: "Repair invalid plugin descriptors and regenerate the bundled plugin table.",
          }),
        );
      }
      return Schema.decodeUnknown(AbsolutePath)(dependencies.paths.pluginStateDir(module.name)).pipe(
        Effect.mapError(descriptorError),
        Effect.map((pluginStateRoot) => {
          const publishRender =
            dependencies.eventService !== undefined && dependencies.redaction !== undefined
              ? makePublishRender(dependencies.eventService, dependencies.redaction)
              : undefined;
          const context = makeLandoPluginContext({
            id: module.name,
            managedFileService: dependencies.managedFileService,
            stateStore: dependencies.stateStore,
            privateFileAccess: dependencies.privateFileAccess,
            pluginStateRoot,
            ...(publishRender === undefined ? {} : { publishRender }),
          });
          return {
            id: contribution.id,
            layer: provided.make(context),
            ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
          };
        }),
      );
    });
  });

export const makeRouterServiceRegistryLive = (modules: ReadonlyArray<LandoPluginModule>) =>
  Layer.effect(
    RouterServiceRegistry,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const paths = yield* PathsService;
      const managedFileService = yield* ManagedFileService;
      const stateStore = yield* StateStore;
      const privateFileAccess = yield* PrivateFileAccessService;
      const eventService = yield* Effect.serviceOption(EventService);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const registrations = yield* registrationsFromModules(modules, {
        paths,
        managedFileService,
        stateStore,
        privateFileAccess,
        ...(eventService._tag === "Some" ? { eventService: eventService.value } : {}),
        ...(redaction._tag === "Some" ? { redaction: redaction.value } : {}),
      });
      const configured = config
        .get("defaultRouterService")
        .pipe(
          Effect.mapError((cause) =>
            selectionError(`Unable to read RouterService selection: ${cause.message}`, "unknown"),
          ),
        );
      return makeRouterServiceRegistry({ registrations, configured, platform: paths.platform });
    }),
  );

export const RouterServiceRegistryLive = Layer.suspend(() =>
  makeRouterServiceRegistryLive(bundledPluginModules()),
);

export const SelectedRouterServiceLive = Layer.unwrapEffect(
  Effect.flatMap(RouterServiceRegistry, (registry) =>
    Effect.flatMap(registry.list, (ids) =>
      ids.length === 0
        ? Effect.succeed(RouterServiceUnavailableLive)
        : registry
            .select()
            .pipe(
              Effect.map((selected) => selected.layer.pipe(Layer.provide(DeferredCertificateAuthorityLive))),
            ),
    ),
  ),
);
