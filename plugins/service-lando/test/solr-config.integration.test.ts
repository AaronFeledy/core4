import { describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";

import { solrServiceType } from "../src/services/solr.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";
import { acquireLiveApp, acquireTempAppRoot, execUntil, writeFixture } from "./support/live-app-scope.ts";

const CORE = "landocore";
const PROBE_VALUE = "us-638-overlay";
const SLUG = "solrcfg638";

describe("solr service type — live integration: file-backed core config", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "boots Solr with a mounted config directory and the running core reports the overlaid property",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      if (socketPath === undefined || socketPath.length === 0) {
        throw new Error("a live provider socket is required for the Solr config integration test");
      }

      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const appRoot = yield* acquireTempAppRoot("lando-solr-config-");
            // Solr loads configoverlay.json out of the core's own conf
            // directory, which is where the start script copies this one.
            yield* writeFixture(
              appRoot,
              "solr/conf/configoverlay.json",
              `${JSON.stringify({ userProps: { "lando.probe": PROBE_VALUE } })}\n`,
            );

            const plan = yield* composeCatalogConfigPlan({
              serviceType: solrServiceType,
              slug: SLUG,
              serviceName: "search",
              appRoot,
              service: { type: "solr", cores: [CORE], config: { dir: "solr/conf" } },
              source: "solr-config.integration.test",
            });

            const app = yield* acquireLiveApp({ plan, socketPath });
            // The Config API answers from the core Solr actually loaded, so it
            // proves the overlay reached the daemon rather than just the disk.
            const result = yield* execUntil({
              app,
              service: "search",
              command: ["curl", "-sf", `http://localhost:8983/solr/${CORE}/config/overlay`],
              accept: (candidate) => candidate.exitCode === 0 && candidate.stdout.includes("overlay"),
              timeoutMs: 150_000,
            });
            const body = JSON.parse(result.stdout) as {
              readonly overlay?: { readonly userProps?: Record<string, unknown> };
            };
            return body.overlay?.userProps?.["lando.probe"];
          }),
        ),
      );

      expect(observed).toBe(PROBE_VALUE);
    },
    240_000,
  );
});
