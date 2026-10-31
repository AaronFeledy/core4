import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import { ProviderId } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type GlobalResolution,
  assertEffectiveGlobalServices,
  projectEffectiveGlobalResolution,
  resolveGlobalServices,
} from "../services/global-services.ts";
import { acquireLandofileReplacement } from "../services/landofile-live.ts";
import type { GlobalPolicy } from "./enablement.ts";
import { captureGlobalResolution } from "./resolution.ts";
import { renderGlobalDist } from "./service.ts";

/** Invocation-local catalog and module evaluation, never provider or admission evidence. */
export const prepareGlobalConfiguration = Effect.fn("GlobalApp.prepareConfiguration")(function* (
  options: Parameters<typeof captureGlobalResolution>[0] = {},
) {
  const captured = yield* captureGlobalResolution(options);
  const modules = new Map<
    string,
    Effect.Effect<import("@lando/sdk/schema").ServiceConfig, import("@lando/sdk/errors").GlobalAppError>
  >();
  const loadServiceConfig: typeof captured.loadServiceConfig = Effect.fnUntraced(function* (entry) {
    const key = `${entry.plugin}\0${entry.contribution.module ?? entry.contribution.id}`;
    let result = modules.get(key);
    if (result === undefined) {
      result = yield* Effect.cached(Effect.suspend(() => captured.loadServiceConfig(entry)));
      modules.set(key, result);
    }
    return yield* result;
  });
  const resolve = (policy: GlobalPolicy = captured.policy) =>
    resolveGlobalServices({ ...captured, policy, loadServiceConfig });
  const paths = yield* (yield* GlobalAppService).paths;
  const compile = Effect.fn("GlobalApp.prepareCandidate")(function* (
    resolution: GlobalResolution,
    services?: ReadonlyArray<string>,
  ) {
    const content = renderGlobalDist(resolution.composableServices);
    const replacement = yield* acquireLandofileReplacement(
      { appRoot: paths.root, targetFile: paths.distLandofile, content },
      {
        name: "global",
        provider: ProviderId.make(captured.providerId),
        excludedServices: resolution.directlyExcludedIds,
      },
    );
    const landofile = replacement.landofile;
    yield* assertEffectiveGlobalServices(
      resolution,
      landofile.document.services ?? {},
      services?.length ? services : undefined,
      landofile.pendingSites,
    );
    const effective = projectEffectiveGlobalResolution(
      resolution,
      landofile.document.services ?? {},
      landofile.pendingSites,
    );
    const excluded = new Set(effective.excludedIds);
    const admitted = rememberLandofileAppRoot(
      copyLandofileProvenance(landofile, {
        ...landofile,
        document: copyLandofileProvenance(landofile.document, {
          ...landofile.document,
          services: effective.services,
        }),
        pendingSites: landofile.pendingSites.filter(
          (site) => site.path[0] !== "services" || !excluded.has(String(site.path[1])),
        ),
      }),
      paths.root,
    );
    return {
      paths,
      content,
      resolution: effective,
      landofile: admitted,
      verify: replacement.verify,
      publishIncludes: replacement.publishIncludes,
      providerCapabilities: captured.providerCapabilities,
    };
  });
  return { captured, resolve, compile };
});

export type PreparedGlobalCandidate = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof prepareGlobalConfiguration>>["compile"]>
>;
