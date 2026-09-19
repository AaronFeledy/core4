import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { composeServicePlan } from "./compose-harness.ts";

/**
 * Builds the one-service app plan the file-backed catalog config tests start.
 *
 * The app name is pinned to the slug rather than derived from the temporary
 * app root, so the database name and the store identity a test asserts against
 * stay readable and stable across runs.
 */
export const composeCatalogConfigPlan = (args: {
  readonly serviceType: ServiceType;
  readonly slug: string;
  readonly serviceName: string;
  readonly appRoot: string;
  readonly service: Record<string, unknown>;
  readonly source: string;
}): Effect.Effect<AppPlan> =>
  Effect.promise(async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: args.slug,
      services: { [args.serviceName]: args.service },
    });
    const service = landofile.services?.[ServiceName.make(args.serviceName)];
    if (service === undefined) throw new Error(`service ${args.serviceName} is missing from the landofile`);

    const servicePlan = await composeServicePlan({
      serviceType: args.serviceType,
      service,
      appRoot: args.appRoot,
      appName: args.slug,
      serviceName: args.serviceName,
      metadata: { resolvedAt: "2026-05-28T00:00:00Z", source: args.source, runtime: 4 },
    });

    return {
      id: AppId.make(args.slug),
      name: args.slug,
      slug: args.slug,
      root: AbsolutePath.make(args.appRoot),
      provider: ProviderId.make("lando"),
      services: { [servicePlan.name]: servicePlan },
      routes: [],
      networks: [],
      // The named volumes the service asks for have to appear on the app plan
      // as well, or teardown has no store to remove and every run leaks the
      // data volume it created.
      stores: servicePlan.storage.map((mount) => ({
        name: mount.store,
        scope: "app" as const,
        kind: "data" as const,
      })),
      fileSync: [],
      metadata: servicePlan.metadata,
      extensions: {},
    };
  });
