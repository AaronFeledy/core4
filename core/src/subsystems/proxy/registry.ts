import { Context, Effect, Either, Layer } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  type CertificateAuthority,
  ConfigService,
  type FileSystem,
  type GlobalAppService,
  type PathsService,
  type ProxyService,
} from "@lando/sdk/services";

import { BUNDLED_PLUGIN_MODULES } from "../../plugins/generated/bundled.ts";
import { makePluginCapabilityIndex } from "../../plugins/module-set.ts";
import { ProxyServiceUnavailableLive } from "./api.ts";
import { DeferredCertificateAuthorityLive } from "./deferred-certificate-authority.ts";

export type ProxyServiceLayer = Layer.Layer<
  ProxyService,
  ProxyError,
  CertificateAuthority | FileSystem | GlobalAppService | PathsService
>;

export interface ProxyServiceRegistration {
  readonly id: string;
  readonly layer: ProxyServiceLayer;
  readonly defaultFor?: {
    readonly platform?: ReadonlyArray<string> | undefined;
  };
}

export interface ProxyServiceSelection {
  readonly explicit?: string;
}

interface ProxyServiceRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<string>>;
  readonly select: (selection?: ProxyServiceSelection) => Effect.Effect<ProxyServiceRegistration, ProxyError>;
}

export class ProxyServiceRegistry extends Context.Tag("@lando/core/ProxyServiceRegistry")<
  ProxyServiceRegistry,
  ProxyServiceRegistryShape
>() {}

interface MakeProxyServiceRegistryOptions {
  readonly registrations: ReadonlyArray<ProxyServiceRegistration>;
  readonly configured: Effect.Effect<string | undefined, ProxyError>;
  readonly platform: string;
}

const selectionError = (message: string, proxyId: string): ProxyError =>
  new ProxyError({
    message,
    proxyId,
    remediation: "Install a ProxyService plugin or configure `defaultProxyService` to an installed id.",
  });

export const makeProxyServiceRegistry = (
  options: MakeProxyServiceRegistryOptions,
): ProxyServiceRegistryShape => {
  const byId = new Map(options.registrations.map((registration) => [registration.id, registration]));
  const selectId = (id: string): Effect.Effect<ProxyServiceRegistration, ProxyError> => {
    const registration = byId.get(id);
    return registration === undefined
      ? Effect.fail(selectionError(`Proxy service ${id} is not installed.`, id))
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
          registration.defaultFor?.platform?.includes(options.platform),
        );
        const matchedDefault = defaults[0];
        if (defaults.length === 1 && matchedDefault !== undefined) return matchedDefault;
        const soleRegistration = options.registrations[0];
        if (options.registrations.length === 1 && soleRegistration !== undefined) return soleRegistration;

        return yield* Effect.fail(
          selectionError("No ProxyService plugin could be selected unambiguously.", "unknown"),
        );
      }),
  };
};

const descriptorError = (cause: unknown): ProxyError =>
  new ProxyError({
    message: "Unable to discover ProxyService contributions.",
    proxyId: "unknown",
    remediation:
      "Repair invalid plugin descriptors and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.",
    cause,
  });

const registrationsFromModules = (
  modules: ReadonlyArray<LandoPluginModule>,
): Effect.Effect<ReadonlyArray<ProxyServiceRegistration>, ProxyError> =>
  Effect.gen(function* () {
    const indexResult = makePluginCapabilityIndex(modules);
    if (Either.isLeft(indexResult)) return yield* Effect.fail(descriptorError(indexResult.left));
    const index = indexResult.right;
    const contributions = index.manifests.flatMap((manifest) => manifest.contributes?.proxyServices ?? []);
    return yield* Effect.forEach(contributions, (contribution) => {
      const layer = index.proxyServices.get(contribution.id);
      return layer === undefined
        ? Effect.fail(
            new ProxyError({
              message: `Proxy service descriptor does not export ${contribution.id}.`,
              proxyId: contribution.id,
              remediation:
                "Repair the plugin proxyServices map and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.",
            }),
          )
        : Effect.succeed({
            id: contribution.id,
            layer,
            ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
          });
    });
  });

export const makeProxyServiceRegistryLive = (
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
) =>
  Layer.effect(
    ProxyServiceRegistry,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const registrations = yield* registrationsFromModules(modules);
      const configured = config
        .get("defaultProxyService")
        .pipe(
          Effect.mapError((cause) =>
            selectionError(`Unable to read ProxyService selection: ${cause.message}`, "unknown"),
          ),
        );
      return makeProxyServiceRegistry({ registrations, configured, platform: process.platform });
    }),
  );

export const ProxyServiceRegistryLive = makeProxyServiceRegistryLive();

export const SelectedProxyServiceLive = Layer.unwrapEffect(
  Effect.flatMap(ProxyServiceRegistry, (registry) =>
    Effect.flatMap(registry.list, (ids) =>
      ids.length === 0
        ? Effect.succeed(ProxyServiceUnavailableLive)
        : registry
            .select()
            .pipe(
              Effect.map((selected) => selected.layer.pipe(Layer.provide(DeferredCertificateAuthorityLive))),
            ),
    ),
  ),
);
