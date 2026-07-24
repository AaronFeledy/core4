import { Context, Effect, Layer } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";
import {
  ConfigService,
  type FileSystem,
  type GlobalAppService,
  type PathsService,
  PluginRegistry,
  type ProxyService,
} from "@lando/sdk/services";

import { BUNDLED_PLUGINS } from "../../plugins/bundled.ts";
import { ProxyServiceUnavailableLive } from "./api.ts";

export type ProxyServiceLayer = Layer.Layer<
  ProxyService,
  ProxyError,
  FileSystem | GlobalAppService | PathsService
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

const isProxyServiceLayer = (value: unknown): value is ProxyServiceLayer => Layer.isLayer(value);

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

const externalProxyLayer = (id: string, modulePath: string): ProxyServiceLayer =>
  Layer.unwrapEffect(
    Effect.tryPromise({
      try: async () => {
        const module: unknown = await import(modulePath);
        if (
          typeof module === "object" &&
          module !== null &&
          "proxy" in module &&
          isProxyServiceLayer(module.proxy)
        ) {
          return module.proxy;
        }
        throw selectionError(`Proxy service module ${modulePath} does not export a ProxyService layer.`, id);
      },
      catch: (cause) =>
        cause instanceof ProxyError
          ? cause
          : new ProxyError({
              message: `Unable to load ProxyService ${id}.`,
              proxyId: id,
              remediation: "Verify the plugin manifest module path and reinstall the plugin.",
              cause,
            }),
    }),
  );

const registrationsFromManifests = (
  manifests: ReadonlyArray<PluginManifest>,
): ReadonlyArray<ProxyServiceRegistration> =>
  manifests.flatMap((manifest) =>
    (manifest.contributes?.proxyServices ?? []).flatMap((contribution) => {
      const bundled = BUNDLED_PLUGINS.find((plugin) => plugin.manifest === manifest);
      const layer =
        bundled?.proxyServices?.get(contribution.id) ??
        externalProxyLayer(contribution.id, contribution.module);
      return [
        {
          id: contribution.id,
          layer,
          ...(contribution.defaultFor === undefined ? {} : { defaultFor: contribution.defaultFor }),
        },
      ];
    }),
  );

export const ProxyServiceRegistryLive = Layer.effect(
  ProxyServiceRegistry,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const plugins = yield* PluginRegistry;
    const manifests = yield* plugins.list.pipe(
      Effect.mapError(
        (cause) =>
          new ProxyError({
            message: "Unable to discover ProxyService contributions.",
            proxyId: "unknown",
            remediation: "Repair invalid plugin manifests and retry.",
            cause,
          }),
      ),
    );
    const configured = config
      .get("defaultProxyService")
      .pipe(
        Effect.mapError((cause) =>
          selectionError(`Unable to read ProxyService selection: ${cause.message}`, "unknown"),
        ),
      );
    return makeProxyServiceRegistry({
      registrations: registrationsFromManifests(manifests),
      configured,
      platform: process.platform,
    });
  }),
);

export const SelectedProxyServiceLive = Layer.unwrapEffect(
  Effect.flatMap(ProxyServiceRegistry, (registry) =>
    Effect.flatMap(registry.list, (ids) =>
      ids.length === 0
        ? Effect.succeed(ProxyServiceUnavailableLive)
        : registry.select().pipe(Effect.map((selected) => selected.layer)),
    ),
  ),
);
