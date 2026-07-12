import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { Effect } from "effect";

import type {
  LogFileHelperPayloadKey,
  LogFileHelperPayloads,
} from "@lando/container-runtime/log-file-helper-payloads";

export const LOG_FILE_HELPER_DIST_ROOT_ENV = "LANDO_LOG_FILE_HELPER_DIST_ROOT";

const payloadKeys = ["linux-x64", "linux-arm64"] as const satisfies ReadonlyArray<LogFileHelperPayloadKey>;

const defaultDistRoot = (execPath: string): string => {
  const execName = basename(execPath).toLowerCase();
  if (execName === "bun" || execName === "bun.exe") return new URL("../../dist", import.meta.url).pathname;
  return dirname(execPath);
};

export const resolveLogFileHelperPayloadPath = (input: {
  readonly distRoot: string;
  readonly key: LogFileHelperPayloadKey;
}): string => `${input.distRoot}/log-file-access/${input.key}/lando-log-file-helper`;

export const defaultLogFileHelperDistRoot = (
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly execPath?: string;
  } = {},
): string => {
  const env = input.env ?? process.env;
  const configured = env[LOG_FILE_HELPER_DIST_ROOT_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  return defaultDistRoot(input.execPath ?? process.execPath);
};

export const loadLogFileHelperPayloads = (
  input: {
    readonly distRoot?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly execPath?: string;
  } = {},
): Effect.Effect<LogFileHelperPayloads> =>
  Effect.gen(function* () {
    const distRoot = input.distRoot ?? defaultLogFileHelperDistRoot(input);
    const entries = yield* Effect.forEach(payloadKeys, (key) =>
      Effect.tryPromise({
        try: () => readFile(resolveLogFileHelperPayloadPath({ distRoot, key })),
        catch: (cause) => cause,
      }).pipe(
        Effect.option,
        Effect.map(
          (bytes) => [key, bytes._tag === "None" ? undefined : new Uint8Array(bytes.value)] as const,
        ),
      ),
    );

    const payloads: LogFileHelperPayloads = {};
    for (const [key, bytes] of entries) {
      if (bytes !== undefined) payloads[key] = bytes;
    }
    return payloads;
  });
