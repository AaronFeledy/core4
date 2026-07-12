import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  defaultLogFileHelperDistRoot,
  loadLogFileHelperPayloads,
  resolveLogFileHelperPayloadPath,
} from "../../src/providers/log-file-helper-payloads.ts";

describe("log file helper payloads", () => {
  test("core build script delivers every supported compiled helper payload path", async () => {
    const packageJson = await readFile(join(import.meta.dir, "../../package.json"), "utf8");

    expect(packageJson).toContain('"build:log-file-helper"');
    expect(packageJson).toContain(
      "--target=bun-linux-x64 --outfile ./dist/log-file-access/linux-x64/lando-log-file-helper",
    );
    expect(packageJson).toContain(
      "--target=bun-linux-arm64 --outfile ./dist/log-file-access/linux-arm64/lando-log-file-helper",
    );
  });

  test("selects deterministic compiled helper sidecars for supported Linux targets", () => {
    const distRoot = "/opt/lando/core/dist";

    expect(resolveLogFileHelperPayloadPath({ distRoot, key: "linux-x64" })).toBe(
      "/opt/lando/core/dist/log-file-access/linux-x64/lando-log-file-helper",
    );
    expect(resolveLogFileHelperPayloadPath({ distRoot, key: "linux-arm64" })).toBe(
      "/opt/lando/core/dist/log-file-access/linux-arm64/lando-log-file-helper",
    );
  });

  test("honors the configured helper dist root", () => {
    expect(
      defaultLogFileHelperDistRoot({ env: { LANDO_LOG_FILE_HELPER_DIST_ROOT: "/opt/lando/dist" } }),
    ).toBe("/opt/lando/dist");
  });

  test("loads available helper payloads and ignores missing architectures", async () => {
    const distRoot = await mkdtemp(join(tmpdir(), "lando-log-file-helper-payloads-"));
    try {
      const helperPath = resolveLogFileHelperPayloadPath({ distRoot, key: "linux-x64" });
      await mkdir(join(distRoot, "log-file-access/linux-x64"), { recursive: true });
      await writeFile(helperPath, new Uint8Array([1, 2, 3]));

      const payloads = await Effect.runPromise(loadLogFileHelperPayloads({ distRoot }));

      expect(payloads["linux-x64"]).toEqual(new Uint8Array([1, 2, 3]));
      expect(payloads["linux-arm64"]).toBeUndefined();
    } finally {
      await rm(distRoot, { recursive: true, force: true });
    }
  });
});
