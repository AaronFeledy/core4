import { expect, test } from "bun:test";
import { ContainerTransportError } from "@lando/container-runtime/transport";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { providerStatus } from "../src/provider-status.ts";
import { makeSystemPodmanMachineRunner } from "../src/setup.ts";

const paths = {
  runtimeDir: "/unused/runtime",
  runtimeBinDir: "/unused/runtime/bin",
  runtimeStorageDir: "/unused/runtime/storage",
  runtimeRunDir: "/unused/runtime/run",
  providerSocketPath: "/unused/runtime/run/podman.sock",
  providerPidPath: "/unused/runtime/run/podman.pid",
};
const unavailable = new ProviderUnavailableError({
  providerId: "lando",
  operation: "info",
  message: "API unavailable",
  remediation: "Inspect the API.",
  cause: new ContainerTransportError({
    kind: "connect",
    operation: "info",
    message: "Socket absent",
    cause: Object.assign(new Error("Socket absent"), { code: "ENOENT" }),
  }),
});
const api = { info: Effect.fail(unavailable), ping: Effect.fail(unavailable) };

test.each(["starting", "unknown", undefined])(
  "machine inspection never interprets %s as stopped",
  async (state) => {
    const machine = makeSystemPodmanMachineRunner("podman", "lando", "darwin", () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify([{ State: state }])));
          controller.close();
        },
      }),
      stderr: undefined,
      exited: Promise.resolve(0),
    }));
    const status = await Effect.runPromise(
      Effect.result(providerStatus({ api, platform: "darwin", managedPaths: paths, machine })),
    );
    expect(status).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "inspect" },
    });
  },
);

test.each(["darwin", "win32"])(
  "%s reports idle only after read-only machine inspection proves stopped",
  async (platform) => {
    const stopped = await Effect.runPromise(
      providerStatus({ api, platform, managedPaths: paths, machine: { inspect: Effect.succeed("stopped") } }),
    );
    expect(stopped.state).toBe("idle");
    const running = await Effect.runPromise(
      Effect.result(
        providerStatus({
          api,
          platform,
          managedPaths: paths,
          machine: { inspect: Effect.succeed("running") },
        }),
      ),
    );
    expect(running).toMatchObject({ _tag: "Failure", failure: unavailable });
    const missingInspect = await Effect.runPromise(
      Effect.result(providerStatus({ api, platform, managedPaths: paths, machine: undefined })),
    );
    expect(missingInspect).toMatchObject({ _tag: "Failure", failure: unavailable });
  },
);

test("API timeouts preserve their tagged failure instead of becoming idle", async () => {
  const error = new ProviderUnavailableError({
    providerId: "lando",
    operation: "info",
    message: "Timed out",
    remediation: "Inspect the runtime API.",
    cause: new ContainerTransportError({
      kind: "read",
      operation: "info",
      message: "Timed out",
      systemCode: "ETIMEDOUT",
    }),
  });
  const result = await Effect.runPromise(
    Effect.result(
      providerStatus({
        api: { info: Effect.fail(error), ping: Effect.fail(error) },
        platform: "linux",
        managedPaths: paths,
        machine: undefined,
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: error });
});

test.each([
  {
    name: "HTTP failure",
    cause: new ContainerTransportError({ kind: "http", operation: "info", message: "HTTP 503" }),
  },
  {
    name: "protocol failure",
    cause: new ContainerTransportError({ kind: "parse", operation: "info", message: "Invalid response" }),
  },
  {
    name: "permission failure",
    cause: new ContainerTransportError({
      kind: "connect",
      operation: "info",
      message: "Denied",
      cause: Object.assign(new Error("Denied"), { code: "EACCES" }),
    }),
  },
  {
    name: "unknown connect failure",
    cause: new ContainerTransportError({ kind: "connect", operation: "info", message: "Unknown" }),
  },
  { name: "unclassified failure", cause: undefined },
])("a stopped machine cannot hide an API $name", async ({ cause }) => {
  const error = new ProviderUnavailableError({
    providerId: "lando",
    operation: "info",
    message: "API failed",
    remediation: "Inspect the API.",
    ...(cause === undefined ? {} : { cause }),
  });
  const result = await Effect.runPromise(
    Effect.result(
      providerStatus({
        api: { info: Effect.fail(error), ping: Effect.fail(error) },
        platform: "darwin",
        managedPaths: paths,
        machine: { inspect: Effect.succeed("stopped") },
      }),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: error });
});
