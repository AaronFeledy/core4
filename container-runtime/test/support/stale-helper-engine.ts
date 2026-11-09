import { Effect, Stream } from "effect";
import type { DataPlaneHttpRequest } from "../../src/data-plane.ts";
import { DATA_HELPER_ROLE, PROVIDER_LABEL, ROLE_LABEL } from "../../src/labels.ts";

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
  const containers = new Map(initial.map((helper) => [helper.id, helper]));
  const calls: DataPlaneHttpRequest[] = [];
  const request = (input: DataPlaneHttpRequest) =>
    Effect.sync(() => {
      calls.push(input);
      if (input.path === "/volumes/data") {
        if (input.method === "GET")
          return {
            status: 200,
            body: JSON.stringify({ Name: "data", Labels: { "dev.lando.volume-instance": generation } }),
          };
        return containers.size === 0 ? { status: 204, body: "" } : { status: 409, body: "volume is in use" };
      }
      if (input.path.startsWith("/containers/json?"))
        return {
          status: 200,
          body: JSON.stringify(
            [...containers.values()].map((helper) => ({
              Id: helper.id,
              Names: [`/${helper.id}`],
              State: helper.state,
              Labels: helper.labels,
              Mounts: [{ Type: "volume", Name: "data" }],
            })),
          ),
        };
      const id = decodeURIComponent(input.path.split("/")[2]?.split("?")[0] ?? "");
      if (input.method === "DELETE" && input.path.startsWith("/containers/")) {
        containers.delete(id);
        return { status: 204, body: "" };
      }
      if (input.path.endsWith("/json")) {
        const helper = containers.get(id);
        return {
          status: 200,
          body: JSON.stringify(
            helper === undefined
              ? { State: { ExitCode: 0 } }
              : {
                  State: {
                    Status: helper.state,
                    StartedAt: helper.startedAt,
                    Running: helper.running ?? helper.state === "running",
                    FinishedAt: helper.finishedAt,
                  },
                  Created: helper.created,
                  Config: { Labels: helper.labels },
                },
          ),
        };
      }
      return { status: 201, body: "{}" };
    });
  return { containers, calls, api: { request, stream: () => Stream.empty } };
};
