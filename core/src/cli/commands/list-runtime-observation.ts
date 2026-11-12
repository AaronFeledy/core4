import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  inspectManagedMachine,
  inspectSilentManagedRuntime,
} from "@lando/container-runtime/podman/managed-status-io";
import {
  RUNTIME_SHUTDOWN_KEY,
  parseRuntimeShutdownReceipt,
} from "@lando/container-runtime/podman/runtime-shutdown";
import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import type { LandoPaths } from "@lando/paths";
import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

export const WINDOWS_MANAGED_MACHINE_PIPE = "\\\\.\\pipe\\podman-lando";

export const isNamedPipeSocketPath = (socketPath: string): boolean =>
  socketPath.startsWith("npipe:") || socketPath.startsWith("\\\\.\\pipe\\");

export const httpSocketPath = (socketPath: string): string =>
  socketPath.startsWith("npipe:") ? normalizeNamedPipePath(socketPath) : socketPath;

export const isAbsentEndpoint = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");

export const requestJsonOnSocket = (socketPath: string, path: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: httpSocketPath(socketPath), path, method: "GET", headers: { Host: "localhost" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new Error(`Container list failed with HTTP ${status}.`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(1500, () => {
      req.destroy();
      reject(new Error("Container list timed out."));
    });
    req.end();
  });

export const observeIdleManagedProvider = async (
  paths: Pick<LandoPaths, "runtimeBinDir" | "providerSocketPath" | "providerPidPath" | "pluginStateDir">,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly processRunner?: Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;
  },
): Promise<ReadonlyArray<string>> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") return [];
  const socket = platform === "win32" ? WINDOWS_MANAGED_MACHINE_PIPE : paths.providerSocketPath;
  try {
    await requestJsonOnSocket(socket, "/info");
  } catch (error) {
    if (isAbsentEndpoint(error) && platform === "linux") {
      const receipt = Effect.tryPromise({
        try: () =>
          readFile(join(paths.pluginStateDir("@lando/provider-lando"), RUNTIME_SHUTDOWN_KEY), "utf8"),
        catch: (cause) => cause,
      }).pipe(Effect.map(parseRuntimeShutdownReceipt));
      const observed = await Effect.runPromise(Effect.result(inspectSilentManagedRuntime(paths, receipt)));
      return observed._tag === "Success" && observed.success.state === "idle" ? ["lando"] : [];
    }
    if (
      isAbsentEndpoint(error) &&
      (platform === "darwin" || platform === "win32") &&
      options.processRunner !== undefined
    ) {
      const observed = await Effect.runPromise(
        Effect.result(
          inspectManagedMachine({
            runtimeBinDir: paths.runtimeBinDir,
            platform,
            env: options.env ?? {},
            runner: options.processRunner,
          }),
        ),
      );
      if (observed._tag === "Success" && observed.success === "stopped") return ["lando"];
    }
  }
  return [];
};
