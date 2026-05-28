import { describe, expect, test } from "bun:test";
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

import { meilisearch1ServiceType } from "../src/services/meilisearch.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("meilinttest");
const MEILI_PORT = 31293;
const MASTER_KEY = "lando";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "meilisearch.integration.test",
  runtime: 4 as const,
};

const waitForMeilisearch = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) {
        const body = (await resp.json()) as Record<string, unknown>;
        if (body.status === "available") return;
        lastError = new Error(`status=${String(body.status)}`);
      } else {
        lastError = new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Meilisearch /health not ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`,
  );
};

describe("meilisearch service type — live integration: index create + document add + search", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Meilisearch v1 and exercises index create + document add + search",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
      if (socketPath === undefined || socketPath.length === 0) {
        throw new Error("LANDO_TEST_PODMAN_SOCKET is required for the Meilisearch integration test");
      }

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-meili-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "meilinttest",
          services: { search: { type: "meilisearch", port: MEILI_PORT } },
        });
        const service = landofile.services?.[ServiceName.make("search")];
        if (service === undefined) throw new Error("search service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const search = meilisearch1ServiceType.toServicePlan({
          name: "search",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Meilisearch Integration App",
          slug: "meilinttest",
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

          await waitForMeilisearch(MEILI_PORT, 120_000);

          // 1. Create an index.
          const createResp = await fetch(`http://127.0.0.1:${MEILI_PORT}/indexes`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${MASTER_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ uid: "movies", primaryKey: "id" }),
          });
          expect(createResp.ok).toBe(true);
          const createBody = (await createResp.json()) as Record<string, unknown>;
          expect(typeof createBody.taskUid).toBe("number");

          // 2. Add a document.
          const addResp = await fetch(`http://127.0.0.1:${MEILI_PORT}/indexes/movies/documents`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${MASTER_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify([{ id: 1, title: "Casablanca" }]),
          });
          expect(addResp.ok).toBe(true);
          const addBody = (await addResp.json()) as Record<string, unknown>;
          expect(typeof addBody.taskUid).toBe("number");

          // 3. Wait for the indexing task to succeed.
          const indexDeadline = Date.now() + 30_000;
          let indexed = false;
          while (Date.now() < indexDeadline) {
            const taskResp = await fetch(`http://127.0.0.1:${MEILI_PORT}/tasks/${String(addBody.taskUid)}`, {
              headers: { Authorization: `Bearer ${MASTER_KEY}` },
            });
            if (taskResp.ok) {
              const taskBody = (await taskResp.json()) as Record<string, unknown>;
              if (taskBody.status === "succeeded") {
                indexed = true;
                break;
              }
              if (taskBody.status === "failed") {
                throw new Error(`Meilisearch indexing task failed: ${JSON.stringify(taskBody)}`);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          expect(indexed).toBe(true);

          // 4. Query the index.
          const searchResp = await fetch(`http://127.0.0.1:${MEILI_PORT}/indexes/movies/search`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${MASTER_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: "casa" }),
          });
          expect(searchResp.ok).toBe(true);
          const searchBody = (await searchResp.json()) as {
            readonly hits: ReadonlyArray<Record<string, unknown>>;
          };
          expect(searchBody.hits.length).toBeGreaterThan(0);
          expect(searchBody.hits[0]?.title).toBe("Casablanca");
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
