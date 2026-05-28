import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "getmeili/meilisearch:v1.11";
const DEFAULT_PORT = 7700;
const DATA_TARGET = PortablePath.make("/meili_data");

/**
 * Dev-environment default master key, deterministic so users can hit
 * `MEILI_MASTER_KEY=lando` in shell snippets and scenario tooling.
 *
 * Per §6.12.4 creds-schema semantics, this is a dev default, not a real
 * secret; it is redacted in `lando info` / event surfaces (§6.6/§6.9)
 * when the publishing layer adds it to the `redact:` token set. Users
 * who need a non-default key set `environment.MEILI_MASTER_KEY` in their
 * Landofile.
 */
export const MEILISEARCH_DEFAULT_MASTER_KEY = "lando" as const;

export const MEILISEARCH_SERVICE_DESCRIPTION = `Meilisearch is an MIT-licensed search engine with a typo-tolerant, ranked search HTTP API. The default local-dev configuration disables telemetry (MEILI_NO_ANALYTICS=true), runs in development mode (MEILI_ENV=development), and seeds a deterministic master key (MEILI_MASTER_KEY=${MEILISEARCH_DEFAULT_MASTER_KEY}) that is redacted from event surfaces per §6.6 / §6.12.4 redaction rules. Override via services.<name>.environment.MEILI_MASTER_KEY in the Landofile for a non-default key.`;

export const meilisearch1ServiceType: ServiceTypeShape = {
  id: "meilisearch:1",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const port = service.port ?? DEFAULT_PORT;

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "meilisearch",
      appName,
      host,
      extraDefaults: {
        MEILI_MASTER_KEY: MEILISEARCH_DEFAULT_MASTER_KEY,
        MEILI_NO_ANALYTICS: "true",
        MEILI_ENV: "development",
        MEILI_HTTP_ADDR: `0.0.0.0:${port}`,
      },
      userEnv: service.environment ?? {},
    });

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "meilisearch",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-meilisearch-data`,
          target: DATA_TARGET,
          readOnly: false,
        },
      ],
      endpoints: [{ port, protocol: "http", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      healthcheck: {
        kind: "command",
        command: ["bash", "-c", `curl -sf http://localhost:${port}/health`],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 30,
      },
      hostAliases: [],
      metadata,
      extensions: {},
    });
  },
};

/** Alias: `type: meilisearch` resolves to the meilisearch:1 image line. */
export const meilisearchServiceType: ServiceTypeShape = {
  id: "meilisearch",
  toServicePlan: (input) =>
    meilisearch1ServiceType.toServicePlan({
      ...input,
      service: { ...input.service },
    }),
};
