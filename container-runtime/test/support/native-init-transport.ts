import assert from "node:assert/strict";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import { makeDockerApiClient } from "../../src/docker/api-client.ts";
import type { EngineApiClient, EngineHttpRequest, EngineHttpResponse } from "../../src/engine-api.ts";
import { makePodmanApiClient } from "../../src/podman/api-client.ts";

type ApiTransport = {
  readonly kind: "api";
  readonly provider: "docker" | "podman";
  readonly endpoint: string;
};
type CommandTransport = {
  readonly kind: "command";
  readonly provider: "podman";
  readonly command: string;
  readonly connection: string;
};
export type NativeInitTransport = ApiTransport | CommandTransport;

export const assertNativeInitTransport = (
  transport: NativeInitTransport,
  platform: NodeJS.Platform = process.platform,
) => {
  switch (transport.kind) {
    case "api":
      assert.ok(transport.endpoint.trim(), "Native-init requires an explicit endpoint");
      if (platform === "win32")
        assert.ok(
          transport.endpoint.startsWith("\\\\.\\pipe\\") || transport.endpoint.startsWith("npipe:"),
          "Windows requires an explicit named-pipe endpoint",
        );
      return;
    case "command":
      assert.ok(transport.command.trim(), "Native-init requires an explicit command");
      assert.ok(
        transport.connection.trim() &&
          !["default", "podman-machine-default"].includes(transport.connection.toLowerCase()),
        'An explicit owned-machine connection is required, never "default"',
      );
      return;
    default: {
      const unreachable: never = transport;
      return unreachable;
    }
  }
};

export const commandTransportArgv = (transport: CommandTransport, args: readonly string[]) => {
  assertNativeInitTransport(transport);
  return [transport.command, "--connection", transport.connection, ...args];
};

const CreateBody = Schema.Struct({
  Image: Schema.String,
  Cmd: Schema.Array(Schema.String),
  HostConfig: Schema.Struct({ Init: Schema.optionalKey(Schema.Boolean) }),
});
const ExecBody = Schema.Struct({ Cmd: Schema.Array(Schema.String) });

const commandClient = (transport: CommandTransport): EngineApiClient => {
  const exits = new Map<string, number>();
  const run = async (args: readonly string[], signal?: AbortSignal) => {
    const child = Bun.spawn(commandTransportArgv(transport, args), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
      killSignal: "SIGKILL",
      ...(signal === undefined ? {} : { signal }),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  const request = (input: EngineHttpRequest) =>
    Effect.tryPromise({
      try: async (signal): Promise<EngineHttpResponse> => {
        const url = new URL(input.path, "http://fixture");
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const id = parts[1];
        const selected = (args: readonly string[]) =>
          run(args, input.signal === undefined ? signal : AbortSignal.any([signal, input.signal]));
        if (input.path === "/libpod/info") {
          const result = await selected(["info", "--format=json"]);
          assert.equal(result.exitCode, 0, result.stderr);
          return { status: 200, body: result.stdout };
        }
        if (parts.includes("images")) {
          const result = await selected(
            input.method === "GET"
              ? ["image", "exists", "docker.io/library/busybox:1.37"]
              : ["pull", "docker.io/library/busybox:1.37"],
          );
          return {
            status: result.exitCode === 0 ? 200 : input.method === "GET" ? 404 : 500,
            body: result.stderr,
          };
        }
        if (url.pathname === "/containers/create") {
          const body = Schema.decodeUnknownSync(CreateBody)(input.body);
          const name = url.searchParams.get("name");
          assert.ok(name);
          const result = await selected([
            "create",
            "--name",
            name,
            "--network=none",
            ...(body.HostConfig.Init === undefined ? [] : [`--init=${body.HostConfig.Init}`]),
            body.Image,
            ...body.Cmd,
          ]);
          assert.equal(result.exitCode, 0, result.stderr);
          return { status: 201, body: JSON.stringify({ Id: result.stdout.trim() }) };
        }
        assert.ok(id, "fixture operation requires an exact id");
        if (parts[0] === "exec") {
          if (parts[2] === "start") return { status: 200, body: "" };
          const exitCode = exits.get(id);
          assert.notEqual(exitCode, undefined);
          exits.delete(id);
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: exitCode }) };
        }
        if (parts[2] === "exec") {
          const body = Schema.decodeUnknownSync(ExecBody)(input.body);
          const result = await selected(["exec", id, ...body.Cmd]);
          const execId = crypto.randomUUID();
          exits.set(execId, result.exitCode);
          return { status: 201, body: JSON.stringify({ Id: execId }) };
        }
        const args =
          input.method === "DELETE"
            ? ["rm", "--force", "--volumes", id]
            : parts[2] === "json"
              ? ["inspect", "--format={{json .}}", id]
              : parts[2] === "logs"
                ? ["logs", id]
                : parts[2] === "stop"
                  ? ["stop", "--time", url.searchParams.get("t") ?? "10", id]
                  : ["start", id];
        const result = await selected(args);
        assert.equal(result.exitCode, 0, result.stderr);
        return {
          status: input.method === "GET" ? 200 : 204,
          body: result.stdout + (parts[2] === "logs" ? result.stderr : ""),
        };
      },
      catch: (cause) =>
        new ProviderUnavailableError({
          providerId: "podman",
          operation: "native-init.command",
          message: "Selected machine fixture command failed.",
          remediation: "Inspect the explicitly selected owned machine connection.",
          cause,
        }),
    });
  return { request, info: request({ method: "GET", path: "/libpod/info" }).pipe(Effect.as({})) };
};

export const nativeInitClient = (
  transport: NativeInitTransport,
  platform?: NodeJS.Platform,
): EngineApiClient => {
  assertNativeInitTransport(transport, platform);
  const ctx = {
    providerId: transport.provider,
    remediation: "Use an already-selected answering fixture transport.",
    env: {},
  };
  switch (transport.kind) {
    case "api":
      return transport.provider === "docker"
        ? makeDockerApiClient(transport.endpoint, ctx)
        : makePodmanApiClient(transport.endpoint, ctx);
    case "command":
      return commandClient(transport);
    default: {
      const unreachable: never = transport;
      return unreachable;
    }
  }
};
