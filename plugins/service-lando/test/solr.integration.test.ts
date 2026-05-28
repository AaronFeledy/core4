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

import { solr9ServiceType } from "../src/services/solr.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("solrinttest");
const SOLR_PORT = 31289;

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "solr.integration.test",
  runtime: 4 as const,
};

const waitForSolr = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/solr/admin/info/system?wt=json`);
      if (resp.ok) return;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Solr system info not ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("solr service type — live integration: system info and core query", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Solr 9 and verifies the system info endpoint responds OK",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-solr-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "solrinttest",
          services: { search: { type: "solr", port: SOLR_PORT } },
        });
        const service = landofile.services?.[ServiceName.make("search")];
        if (service === undefined) throw new Error("search service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const search = solr9ServiceType.toServicePlan({
          name: "search",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Solr Integration App",
          slug: "solrinttest",
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

          // Solr takes longer to start than Redis/Memcached; allow 90s.
          await waitForSolr(SOLR_PORT, 90_000);

          const sysResp = await fetch(`http://127.0.0.1:${SOLR_PORT}/solr/admin/info/system?wt=json`);
          expect(sysResp.ok).toBe(true);
          const sysBody = (await sysResp.json()) as Record<string, unknown>;
          expect(sysBody.responseHeader).toBeTruthy();
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Solr 9 with a pre-created core and verifies the core is queryable",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const CORE_PORT = SOLR_PORT + 1;

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-solr-core-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "solrinttest",
          services: { search: { type: "solr", port: CORE_PORT, cores: ["gettingstarted"] } },
        });
        const service = landofile.services?.[ServiceName.make("search")];
        if (service === undefined) throw new Error("search service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const search = solr9ServiceType.toServicePlan({
          name: "search",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Solr Core Integration App",
          slug: "solrinttest",
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

          await waitForSolr(CORE_PORT, 90_000);

          // Verify the pre-created core is present via cores admin API.
          const coresResp = await fetch(
            `http://127.0.0.1:${CORE_PORT}/solr/admin/cores?action=STATUS&wt=json`,
          );
          expect(coresResp.ok).toBe(true);
          const coresBody = (await coresResp.json()) as { status: Record<string, unknown> };
          expect(Object.keys(coresBody.status)).toContain("gettingstarted");
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
