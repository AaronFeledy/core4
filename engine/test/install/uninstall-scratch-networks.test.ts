import { expect, test } from "bun:test";
import { preflightDataRootPurge } from "@lando/container-runtime/data-root-purge";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { LANDO_DATA_ROOT_LABEL, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";

const root = "/tmp/uninstall-scratch-network";
const labels = {
  [LANDO_DATA_ROOT_LABEL]: root,
  "dev.lando.app": "scratch-app",
  "dev.lando.app-root": root,
  "dev.lando.owner": appIdentityKey("owner", root),
  "dev.lando.provider": "lando",
  "dev.lando.scratch": "TRUE",
  "dev.lando.scratch-id": "scratch-app",
};

test.each(["complete", "partial-scratch", "wrong-id"] as const)(
  "uninstall removes scratch network only with complete ownership proof: %s",
  async (proof) => {
    const removals: string[] = [];
    const observedLabels =
      proof === "partial-scratch"
        ? Object.fromEntries(Object.entries(labels).filter(([key]) => key !== "dev.lando.scratch-id"))
        : proof === "wrong-id"
          ? { ...labels, "dev.lando.scratch-id": "other" }
          : labels;
    const api: EngineHttpApi = {
      request: ({ path, method }) =>
        Effect.sync(() => {
          if (method === "DELETE") {
            removals.push(path);
            return { status: 204, body: "" };
          }
          const body = path.startsWith("/networks?")
            ? [{ Id: "scratch-net-id" }]
            : path === "/networks/scratch-net-id"
              ? { Id: "scratch-net-id", Name: "scratch-bridge", Labels: observedLabels }
              : path.startsWith("/volumes?")
                ? { Volumes: [] }
                : [];
          return { status: 200, body: JSON.stringify(body) };
        }),
    };
    const prepared = await Effect.runPromise(
      preflightDataRootPurge(
        api,
        { providerId: "podman", env: {}, remediation: "Retry" },
        {
          dataRoot: root,
          buildStore: "fixture",
          endpoint: "/fixture.sock",
          pluginId: "@lando/provider-podman",
        },
      ),
    );
    if (prepared.kind !== "reachable") throw new Error("Fixture is unreachable");
    const result = await Effect.runPromise(prepared.sweep());
    expect(result.failed).toEqual([]);
    expect(result.retained).toHaveLength(proof === "complete" ? 0 : 1);
    expect(removals).toEqual(proof === "complete" ? ["/networks/scratch-net-id"] : []);
  },
);
