import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { elasticsearch8ServiceType } from "../src/services/elasticsearch.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("esinttest");
const ES_PORT = 31291;

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "elasticsearch.integration.test",
  runtime: 4 as const,
};

const waitForElasticsearch = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/_cluster/health`);
      if (resp.ok) return;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Elasticsearch cluster health not ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`,
  );
};

describe("elasticsearch service type — live integration: cluster health endpoint", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Elasticsearch 8 (single-node, security-disabled) and verifies green/yellow cluster health",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-es-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "esinttest",
          services: { search: { type: "elasticsearch", port: ES_PORT } },
        });
        const service = landofile.services?.[ServiceName.make("search")];
        if (service === undefined) throw new Error("search service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const search = elasticsearch8ServiceType.__legacyToServicePlan({
          name: "search",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Elasticsearch Integration App",
          slug: "esinttest",
          root: appRoot,
          provider: providerId,
          services: { [search.name]: search },
          routes: [],
          networks: [],
          stores: [],
          metadata: search.metadata,
          extensions: {},
        };

        const api = makePodmanApiClient(socketPath);
        try {
          const applied = await Effect.runPromise(bringUp(plan, { podmanApi: api }));
          expect(applied.changed).toBe(true);

          await waitForElasticsearch(ES_PORT, 120_000);

          const healthResp = await fetch(`http://127.0.0.1:${ES_PORT}/_cluster/health`);
          expect(healthResp.ok).toBe(true);
          const healthBody = (await healthResp.json()) as Record<string, unknown>;
          expect(["green", "yellow"]).toContain(healthBody.status);

          const indicesResp = await fetch(`http://127.0.0.1:${ES_PORT}/_cat/indices`);
          expect(indicesResp.ok).toBe(true);
          expect(await indicesResp.text()).toBeString();
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
