import { Context, Effect, Either, Layer } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import {
  type CertificateAuthority,
  ConfigService,
  type FileSystem,
  type GlobalAppService,
  PathsService,
  type RouterService,
} from "@lando/sdk/services";

import { bundledPluginModules } from "../../composition.ts";
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
): Effect.Effect<ReadonlyArray<RouterServiceRegistration>, ProxyError> =>
  Effect.gen(function* () {
    const indexResult = makePluginCapabilityIndex(modules);
    if (Either.isLeft(indexResult)) return yield* Effect.fail(descriptorError(indexResult.left));
    const index = indexResult.right;
    const contributions = index.manifests.flatMap((manifest) => manifest.contributes?.routerServices ?? []);
    return yield* Effect.forEach(contributions, (contribution) => {
      const layer = index.routerServices.get(contribution.id);
      return layer === undefined
        ? Effect.fail(
            new ProxyError({
              message: `Router service descriptor does not export ${contribution.id}.`,
              proxyId: contribution.id,
              remediation:
                "Repair the plugin routerServices map and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.",
            }),
          )
        : Effect.succeed({
            id: contribution.id,
            layer,
            ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
          });
    });
  });

export const makeRouterServiceRegistryLive = (modules: ReadonlyArray<LandoPluginModule>) =>
  Layer.effect(
    RouterServiceRegistry,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const paths = yield* PathsService;
      const registrations = yield* registrationsFromModules(modules);
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
