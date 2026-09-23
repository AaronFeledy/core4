import type { PluginDoctorCheckInput, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect, Match } from "effect";
import { lando3ProjectName } from "./naming.ts";

const skipped = (name: string, reason: string): PluginDoctorReport => ({
  name,
  status: "pass",
  severity: "info",
  runtimeStatus: "skipped",
  context: { reason },
  solutions: [],
});

export const runLando3Leftovers = (
  input: PluginDoctorCheckInput,
): Effect.Effect<ReadonlyArray<PluginDoctorReport>, never> =>
  Effect.gen(function* () {
    const name = "lando3-leftovers";
    if (input.app === undefined)
      return [
        {
          ...skipped(name, "no-app-context"),
          solutions: [
            {
              kind: "manual",
              description: "Run `lando4 doctor` inside an app to check for Lando 3 leftovers.",
              command: "lando4 doctor",
            },
          ],
        },
      ];
    if (input.providerId === "lando") return [skipped(name, "managed-provider")];
    if (input.providerId !== "docker" && input.providerId !== "podman")
      return [skipped(name, "unsupported-provider")];
    if (input.resources === undefined) return [skipped(name, "no-inspector")];
    const project = lando3ProjectName(input.app.name);
    if (project === "") return [skipped(name, "no-project-name")];

    const volumes = yield* input.resources.inspect({ kind: "volume", namePrefix: `${project}_`, limit: 32 });
    const containers = yield* input.resources.inspect({
      kind: "container",
      label: { key: "io.lando.root", value: input.app.root },
      limit: 32,
    });
    const context: Record<string, string> = { project: project.slice(0, 2000), providerId: input.providerId };
    const reasons: string[] = [];
    let hasHits = false;
    for (const [key, inspection] of [
      ["volumes", volumes],
      ["containers", containers],
    ] as const) {
      Match.value(inspection).pipe(
        Match.when({ status: "ok" }, ({ names, truncated }) => {
          const joined = names.join(",");
          context[key] = joined.slice(0, 2000);
          if (truncated || joined.length > 2000) context[`${key}Truncated`] = "true";
          hasHits ||= names.length > 0;
        }),
        Match.when({ status: "unsupported" }, ({ reason }) => {
          reasons.push(reason);
        }),
        Match.when({ status: "unavailable" }, ({ reason }) => {
          reasons.push(reason);
        }),
        Match.exhaustive,
      );
    }
    if (hasHits)
      return [
        {
          name,
          status: "warn",
          severity: "warn",
          runtimeStatus: "lando3-resources-found",
          context,
          solutions: [
            {
              kind: "manual",
              description:
                "These look like Lando 3 resources for this app. Lando 4 did not change or remove them. Back up or confirm any data you need, then remove them with Lando 3 (for example, run Lando 3's `lando destroy` in this app).",
            },
          ],
        },
      ];
    if (reasons.length > 0)
      return [
        {
          name,
          status: "pass",
          severity: "info",
          runtimeStatus: "unverified",
          context: { ...context, reason: reasons.join("; ").slice(0, 2000) },
          solutions: [
            {
              kind: "manual",
              description: "Re-run `lando4 doctor` when the provider is reachable.",
              command: "lando4 doctor",
            },
          ],
        },
      ];
    return [{ name, status: "pass", severity: "info", runtimeStatus: "none-found", context, solutions: [] }];
  });

export const runLando3Shadow = (
  input: PluginDoctorCheckInput,
): Effect.Effect<ReadonlyArray<PluginDoctorReport>, never> =>
  Effect.gen(function* () {
    const name = "lando3-shadow";
    if (input.executables === undefined) return [skipped(name, "no-locator")];
    const location = yield* input.executables.locate("lando");
    if (location.runningBasename !== "lando4") return [skipped(name, "not-running-as-lando4")];
    const result: PluginDoctorReport = Match.value(location.candidate).pipe(
      Match.when(
        { kind: "missing" },
        () =>
          ({
            name,
            status: "pass",
            severity: "info",
            runtimeStatus: "no-lando-on-path",
            context: {},
            solutions: [],
          }) as const,
      ),
      Match.when(
        { kind: "ambiguous" },
        ({ reason }) =>
          ({
            name,
            status: "pass",
            severity: "info",
            runtimeStatus: "unverified",
            context: { reason: reason.slice(0, 2000) },
            solutions: [],
          }) as const,
      ),
      Match.when({ kind: "found" }, ({ path }): PluginDoctorReport => {
        const context = {
          candidate: path.slice(0, 2000),
          ...(location.runningPath === undefined ? {} : { runningPath: location.runningPath.slice(0, 2000) }),
        };
        if (path === location.runningPath)
          return {
            name,
            status: "pass",
            severity: "info",
            runtimeStatus: "same-executable",
            context,
            solutions: [],
          };
        return {
          name,
          status: "pass",
          severity: "info",
          runtimeStatus: "potential-shadow",
          context,
          solutions: [
            {
              kind: "manual",
              description:
                "A different `lando` is on PATH. Lando 4 did not run or inspect it and makes no claim about its version. Keep using `lando4` for Lando 4 and `lando` for Lando 3 side by side.",
            },
          ],
        };
      }),
      Match.exhaustive,
    );
    return [result];
  });
