import { expect, test } from "bun:test";
import { Effect } from "effect";

import { makeTraefikProxyService } from "@lando/proxy-traefik";
import { runProxyServiceContractSuite } from "@lando/sdk/test";

test("bundled Traefik satisfies the ProxyService contract suite", async () => {
  const files = new Map<string, string>();
  const service = makeTraefikProxyService({
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: { ensureRunning: () => Effect.void },
  });

  await Effect.runPromise(
    runProxyServiceContractSuite({
      service,
      readRoutes: service.readAppliedRoutes,
    }),
  );

  expect(files.size).toBe(0);
});
