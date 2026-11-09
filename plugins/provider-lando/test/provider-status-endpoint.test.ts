import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { makeLandoPaths } from "@lando/paths";
import { Effect } from "effect";
import { providerStatus } from "../src/provider-status.ts";

test.each(["ENOENT", "ECONNREFUSED"])(
  "only definitive %s permits stopped-machine idle proof",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "lando-status-absent-"));
    const socket = join(root, "api.sock");
    try {
      if (code === "ECONNREFUSED") await writeFile(socket, "");
      const api = makePodmanApiClient(socket, { providerId: "lando", remediation: "Inspect API.", env: {} });
      const result = await Effect.runPromise(
        providerStatus({
          api,
          platform: "darwin",
          managedPaths: makeLandoPaths({ userDataRoot: root }),
          machine: { inspect: Effect.succeed("stopped") },
        }),
      );
      expect(result.state).toBe("idle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["HTTP failure", "malformed JSON", "answering"] as const)(
  "status preserves the real API %s without consulting machine state",
  async (responseKind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-status-api-"));
    const socket = join(root, "api.sock");
    const server = createServer((_request, response) => {
      response.writeHead(responseKind === "HTTP failure" ? 503 : 200);
      response.end(responseKind === "answering" ? "{}" : "invalid-json");
    });
    try {
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      const api = makePodmanApiClient(socket, { providerId: "lando", remediation: "Inspect API.", env: {} });
      const result = await Effect.runPromise(
        Effect.result(
          providerStatus({
            api,
            platform: "darwin",
            managedPaths: makeLandoPaths({ userDataRoot: root }),
            machine: { inspect: Effect.die("reachable or failed API must not inspect the machine") },
          }),
        ),
      );
      switch (responseKind) {
        case "answering":
          expect(result).toMatchObject({ _tag: "Success", success: { state: "running" } });
          break;
        case "HTTP failure":
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProviderUnavailableError", operation: "capabilities" },
          });
          break;
        case "malformed JSON":
          expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderCapabilityError" } });
          break;
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an installed Linux runtime with a definitively absent API fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-status-silent-"));
  try {
    const paths = makeLandoPaths({ userDataRoot: root });
    await mkdir(paths.runtimeBinDir, { recursive: true });
    await writeFile(join(paths.runtimeBinDir, ".runtime-installed-version"), "0.1.7");
    await writeFile(join(paths.runtimeBinDir, "podman"), "", { mode: 0o755 });
    const api = makePodmanApiClient(paths.providerSocketPath, {
      providerId: "lando",
      remediation: "Inspect API.",
      env: {},
    });
    const result = await Effect.runPromise(
      Effect.result(
        providerStatus({
          api,
          platform: "linux",
          managedPaths: paths,
          machine: undefined,
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "getStatus" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
