import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { FilePermissionError, LandofileValidationError } from "@lando/sdk/errors";

import { resolveCertsFeature } from "../../src/services/service-certs.ts";

test("reads both custom certificate files and rejects an unreadable key", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-service-certs-read-"));
  const certPath = join(appRoot, "certs", "custom.crt");
  const keyPath = join(appRoot, "certs", "custom.key");
  const reads: string[] = [];

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(certPath, "cert\n", "utf-8");
    await writeFile(keyPath, "key\n", "utf-8");

    // Given: a regular custom cert/key pair whose key cannot be read.
    const fileSystem = {
      stat: () => Effect.succeed({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false }),
      readFile: (path: string) => {
        reads.push(path);
        return path === keyPath
          ? Effect.fail(new FilePermissionError({ message: "permission denied", path }))
          : Effect.succeed("cert");
      },
    };

    // When: custom certificate resolution validates both authored files.
    const failure = await Effect.runPromise(
      Effect.flip(
        resolveCertsFeature({
          appName: "certs-read",
          appRoot,
          serviceName: "web",
          certs: { cert: "./certs/custom.crt", key: "./certs/custom.key" },
          hostnames: [],
          routes: [],
          fileSystem,
        }),
      ),
    );

    // Then: both files were read and the existing authored-path remediation is returned.
    expect(reads).toEqual([certPath, keyPath]);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(String(failure)).toContain("path ./certs/custom.key could not be read");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
