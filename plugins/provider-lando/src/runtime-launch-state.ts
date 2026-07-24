import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanServiceSpec } from "./podman-service-runner.ts";

interface RuntimeLaunchState {
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
}

export const launchStatePath = (pidPath: string): string => `${pidPath}.launch.json`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRuntimeLaunchState = (raw: string): RuntimeLaunchState | undefined => {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    !isRecord(parsed.env)
  ) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.env)) {
    if (typeof value !== "string") return undefined;
    env[key] = value;
  }

  return { pid: parsed.pid, env };
};

const readLaunchState = (pidPath: string): Effect.Effect<RuntimeLaunchState | undefined> =>
  Effect.tryPromise({
    try: async () => parseRuntimeLaunchState(await readFile(launchStatePath(pidPath), "utf8")),
    catch: () => undefined,
  }).pipe(Effect.catchAll((state) => Effect.succeed(state)));

const sameSpecEnv = (
  recordedEnv: Readonly<Record<string, string>>,
  expectedEnv: Readonly<Record<string, string>> | undefined,
): boolean => {
  const expectedEntries = Object.entries(expectedEnv ?? {});
  return (
    Object.keys(recordedEnv).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => recordedEnv[key] === value)
  );
};

export const recordedLaunchMatchesSpec = (
  pidPath: string,
  pid: number,
  spec: PodmanServiceSpec,
): Effect.Effect<boolean> =>
  readLaunchState(pidPath).pipe(
    Effect.map((state) => state !== undefined && state.pid === pid && sameSpecEnv(state.env, spec.env)),
  );

export const writeLaunchState = (
  pidPath: string,
  pid: number,
  spec: PodmanServiceSpec,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const state: RuntimeLaunchState = { pid, env: spec.env ?? {} };
      const path = launchStatePath(pidPath);
      const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(tempPath, JSON.stringify(state), { mode: 0o600 });
        await rename(tempPath, path);
      } finally {
        await rm(tempPath, { force: true });
      }
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "Failed to write the Lando runtime service launch state.",
        remediation: "Verify the Lando runtime directory is writable, then rerun the command.",
        details: { statePath: launchStatePath(pidPath) },
        cause,
      }),
  });
