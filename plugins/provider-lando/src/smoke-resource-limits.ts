import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import {
  ProviderLandoSmokeError,
  type SmokeProbeDeps,
  acquireSmokeContainer,
  expectSmokeSuccess,
  parseSmokeExitCode,
  smokeApiRequest,
  smokeRemediation,
  startSmokeContainer,
} from "./smoke-probe-support.ts";

// Each `deploy.resources` field maps to one cgroup file inside the container; a mismatch exits
// with the code of the first file that does not hold the requested value.
const RESOURCE_LIMIT_EXPECTATIONS = [
  { file: "memory.max", value: "134217728", exitCode: 11 },
  { file: "pids.max", value: "100", exitCode: 12 },
  { file: "cpu.max", value: "50000 100000", exitCode: 13 },
  { file: "memory.low", value: "67108864", exitCode: 14 },
] as const;

const resourceLimitScript = RESOURCE_LIMIT_EXPECTATIONS.map(
  ({ file, value, exitCode }) => `[ "$(cat /sys/fs/cgroup/${file})" = "${value}" ] || exit ${exitCode}`,
).join("; ");

/** Limits, reservation and CPU quota requested at create must be what the container's cgroup enforces. */
export const runResourceLimitSmokeProbe = (deps: SmokeProbeDeps, image: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `provider-lando-smoke-resources-${randomUUID()}`;
      yield* acquireSmokeContainer(deps, {
        operation: "resource-limits",
        name,
        body: {
          Image: image,
          Cmd: ["sh", "-c", resourceLimitScript],
          HostConfig: {
            Memory: 134_217_728,
            MemoryReservation: 67_108_864,
            PidsLimit: 100,
            NanoCpus: 500_000_000,
          },
        },
      });
      yield* startSmokeContainer(deps, "resource-limits", name);
      const response = yield* smokeApiRequest(deps, "resource-limits", {
        method: "POST",
        path: `/containers/${encodeURIComponent(name)}/wait`,
      }).pipe(
        Effect.flatMap((value) =>
          expectSmokeSuccess(
            "resource-limits",
            value,
            "Podman could not wait for the resource-limit smoke container.",
          ),
        ),
      );
      const exitCode = parseSmokeExitCode(response.body);
      if (exitCode === 0) return;
      const mismatch = RESOURCE_LIMIT_EXPECTATIONS.find((expectation) => expectation.exitCode === exitCode);
      return yield* Effect.fail(
        new ProviderLandoSmokeError({
          smokeOperation: "resource-limits",
          message:
            mismatch === undefined
              ? `The resource-limit smoke container exited with code ${String(exitCode ?? "unknown")}.`
              : `The container's /sys/fs/cgroup/${mismatch.file} does not hold the requested ${mismatch.value}.`,
          remediation: smokeRemediation("resource-limits"),
          details: {
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(mismatch === undefined ? {} : { file: mismatch.file, expected: mismatch.value }),
          },
        }),
      );
    }),
  );
