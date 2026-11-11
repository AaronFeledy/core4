import { Effect } from "effect";
import type { DataPlaneHttpRequest } from "../../src/data-plane.ts";
import { DATA_HELPER_ROLE, PROVIDER_LABEL, ROLE_LABEL } from "../../src/labels.ts";
import { FakeEngine } from "./fake-engine.ts";

export const NOW = 1_700_000_000_000;
export const generation = "00000000-0000-4000-8000-000000000001";
export const helperLabels = (providerId = "test") => ({
  [ROLE_LABEL]: DATA_HELPER_ROLE,
  [PROVIDER_LABEL]: providerId,
});
export const staleTime = new Date(NOW - 600_001).toISOString();
export const freshTime = new Date(NOW - 60_000).toISOString();
export const redactor = {
  redactString: (value: string) => value.replaceAll("SENSITIVE", "[REDACTED]"),
  redactValue: (value: unknown) => value,
};

export interface Helper {
  readonly id: string;
  readonly state: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly finishedAt?: string;
  readonly startedAt?: string;
  readonly created?: string;
  readonly running?: boolean;
}

export const staleHelper = (id: string): Helper => ({
  id,
  state: "exited",
  labels: helperLabels(),
  finishedAt: staleTime,
});

export const helperEngine = (initial: ReadonlyArray<Helper>) => {
  const engine = new FakeEngine();
  const helpers = new Map(initial.map((helper) => [helper.id, helper]));
  for (const helper of initial) {
    engine.seedContainer(helper.id, {
      Image: "fixture",
      Labels: helper.labels,
      HostConfig: { Binds: ["data:/data"] },
    });
    const container = engine.containers.get(helper.id);
    if (container === undefined) throw new Error("Missing seeded helper");
    engine.containers.entries.set(helper.id, { ...container, id: helper.id });
  }
  engine.assets.volumes.set("data", { Name: "data", Labels: { "dev.lando.volume-instance": generation } });
  const calls: DataPlaneHttpRequest[] = [];
  const request = (input: DataPlaneHttpRequest) =>
    Effect.suspend(() => {
      calls.push(input);
      // Ignore list filters so the sweep must independently verify each inspected helper's ownership.
      if (input.path.startsWith("/containers/json?")) return Effect.succeed(engine.containers.list({}));
      const id = decodeURIComponent(input.path.split("/")[2]?.split("?")[0] ?? "");
      const helper = helpers.get(id);
      if (input.path.endsWith("/json") && helper !== undefined && engine.containers.get(id) !== undefined) {
        return Effect.succeed({
          status: 200,
          body: JSON.stringify({
            State: {
              Status: helper.state,
              StartedAt: helper.startedAt,
              Running: helper.running ?? helper.state === "running",
              FinishedAt: helper.finishedAt,
            },
            Created: helper.created,
            Config: { Labels: helper.labels },
          }),
        });
      }
      return engine.request(input);
    });
  return {
    containers: engine.containers.entries,
    volumes: engine.assets.volumes,
    calls,
    api: { request, stream: engine.stream },
  };
};
