import { expect, test } from "bun:test";
import { Effect } from "effect";

import { makeTraefikProxyService } from "@lando/proxy-traefik";
import { runProxyServiceContractSuite } from "@lando/sdk/test";

test("bundled Traefik satisfies the ProxyService contract suite", async () => {
  const files = new Map<string, string>();
  const service = makeTraefikProxyService({
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) => Effect.succeed(files.has(path) || path.endsWith("/dynamic")),
      readDir: (path) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path) => Effect.succeed(files.get(path) ?? ""),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: {
      ensureRunning: () =>
        Effect.succeed([
          {
            name: "traefik",
            state: "running",
            endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
          },
        ]),
    },
  });

  await Effect.runPromise(
    runProxyServiceContractSuite({
      service,
      readRoutes: service.readAppliedRoutes,
    }),
  );

  expect(files.size).toBe(0);
});
