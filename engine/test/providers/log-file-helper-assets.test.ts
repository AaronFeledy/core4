import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { LogFileHelperAssets } from "@lando/sdk/services";

import {
  LOG_FILE_HELPER_DIST_ROOT_ENV,
  LogFileHelperAssetsLive,
  loadLogFileHelperPayloads,
  resolveLogFileHelperPayloadPath,
} from "../../src/providers/log-file-helper-payloads.ts";

test("LogFileHelperAssets loads helper payloads once per layer build", async () => {
  // Given
  const distRoot = await mkdtemp(join(tmpdir(), "lando-log-file-helper-assets-"));
  const previousDistRoot = process.env[LOG_FILE_HELPER_DIST_ROOT_ENV];
  try {
    const helperPath = resolveLogFileHelperPayloadPath({ distRoot, key: "linux-x64" });
    await mkdir(join(distRoot, "log-file-access/linux-x64"), { recursive: true });
    await writeFile(helperPath, new Uint8Array([4, 2]));
    process.env[LOG_FILE_HELPER_DIST_ROOT_ENV] = distRoot;
    const expected = await Effect.runPromise(loadLogFileHelperPayloads({ distRoot }));

    // When
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const assets = yield* LogFileHelperAssets;
        const firstAccess = yield* assets.payloads;
        const secondAccess = yield* assets.payloads;
        return [firstAccess, secondAccess] as const;
      }).pipe(Effect.provide(LogFileHelperAssetsLive)),
    );

    // Then
    expect(first).toEqual(expected);
    expect(second).toBe(first);
  } finally {
    if (previousDistRoot === undefined) delete process.env[LOG_FILE_HELPER_DIST_ROOT_ENV];
    else process.env[LOG_FILE_HELPER_DIST_ROOT_ENV] = previousDistRoot;
    await rm(distRoot, { recursive: true, force: true });
  }
});
