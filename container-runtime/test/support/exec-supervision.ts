import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { ContainerHelperUnavailableError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type ContainerHelperTarget } from "@lando/sdk/schema";
import { Effect, Stream } from "effect";
import { engineInfoArchitecture, hostProxyContainerTargets } from "../../src/capabilities.ts";
import type { EngineHttpApi, EngineHttpRequest } from "../../src/engine-api.ts";
import type { ResolveContainerHelper } from "../../src/log-source-binding.ts";
import { encodeUstarHeader } from "../../src/tar.ts";

const root = mkdtempSync(join(tmpdir(), "lando-supervised-exec-fixture-"));
const path = join(root, "helper");
const bytes = new TextEncoder().encode("supervised-exec-protocol-fixture");
writeFileSync(path, bytes);
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const resolveHelper: ResolveContainerHelper = (target) =>
  Effect.succeed({ target, path: AbsolutePath.make(path), digest: sha256Hex(bytes) });
const installed = new WeakSet<EngineHttpApi>();

/** Resolve real build artifacts for live provider tests without importing the core implementation. */
export const resolveBuiltContainerHelperForTest: ResolveContainerHelper = (target) =>
  Effect.try({
    try: () => {
      const root =
        process.env.LANDO_CONTAINER_HELPER_DIR ??
        resolve(import.meta.dirname, "../../../core/container-helper/dist");
      const path = join(root, `linux-${target.arch}`, "lando-container-helper");
      return { target, path: AbsolutePath.make(path), digest: sha256Hex(readFileSync(path)) };
    },
    catch: (cause) =>
      new ContainerHelperUnavailableError({
        target,
        cause,
        message: "Built container helper is unavailable for live tests.",
        remediation: "Build container helpers before running live provider tests.",
      }),
  });

export const containerHelperTestOptions = (
  api: EngineHttpApi & { readonly info: Effect.Effect<unknown, unknown> },
) =>
  Effect.gen(function* () {
    const info = yield* api.info;
    const target = hostProxyContainerTargets(engineInfoArchitecture(info))[0];
    if (target === undefined)
      return yield* Effect.fail(new Error("Test daemon did not report its container architecture."));
    return { resolveContainerHelper: resolveBuiltContainerHelperForTest, helperTarget: target };
  });

/** Provider contract fakes opt in to the actual strict wrapper's helper resolver and wire protocol. */
export const supervisedExecFixtureOptions = (
  api: EngineHttpApi | undefined,
): {
  readonly resolveContainerHelper?: ResolveContainerHelper;
  readonly helperTarget?: ContainerHelperTarget;
} =>
  api !== undefined && installed.has(api)
    ? { resolveContainerHelper: resolveHelper, helperTarget: { os: "linux", arch: "x64" } }
    : {};

const frame = (value: unknown): Uint8Array => {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const output = new Uint8Array(8 + payload.length);
  output[0] = 1;
  new DataView(output.buffer).setUint32(4, payload.length);
  output.set(payload, 8);
  return output;
};
interface Session {
  main?: string;
  started: boolean;
  collected: boolean;
  cancelled: boolean;
  readonly collect: Promise<void>;
  readonly finish: () => void;
}

/** Extend an existing daemon fake, preserving its user-command behavior and inspecting its actual command result. */
export const installSupervisedExecFixture = (api: EngineHttpApi): void => {
  if (installed.has(api)) return;
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined)
    throw new TypeError("Supervised exec fixture requires request and stream.");
  installed.add(api);
  if ("info" in api)
    Object.assign(api, {
      info: (api.info as Effect.Effect<object>).pipe(
        Effect.map((info) => ({ ...info, Architecture: "amd64" })),
      ),
    });
  const names = new Map<string, string>();
  const archives = new Map<string, Uint8Array>();
  const sessions = new Map<string, Session>();
  const controls = new Map<string, readonly string[]>();
  const mains = new Map<string, Session>();
  let next = 0;
  const sessionFor = (directory: string): Session => {
    let session = sessions.get(directory);
    if (session === undefined) {
      let finish: () => void = () => undefined;
      const collect = new Promise<void>((resolve) => {
        finish = resolve;
      });
      session = { started: false, collected: false, cancelled: false, collect, finish };
      sessions.set(directory, session);
    }
    return session;
  };
  const originalContainer = (input: EngineHttpRequest): EngineHttpRequest => {
    const match = /^\/containers\/([^/]+)\/exec$/u.exec(input.path);
    const name = match?.[1] === undefined ? undefined : names.get(decodeURIComponent(match[1]));
    return name === undefined ? input : { ...input, path: `/containers/${encodeURIComponent(name)}/exec` };
  };
  const observedExit = (session: Session) =>
    session.main === undefined
      ? Effect.succeed(0)
      : request({ method: "GET", path: `/exec/${encodeURIComponent(session.main)}/json` }).pipe(
          Effect.map((response) => {
            const state = JSON.parse(response.body) as { ExitCode?: number };
            return state.ExitCode ?? 0;
          }),
        );
  Object.assign(api, {
    request: (input: EngineHttpRequest) =>
      Effect.gen(function* () {
        if (input.method === "PUT" && input.path.includes("/archive?path=/tmp&noOverwriteDirNonDir=true")) {
          const chunks: Uint8Array[] = [];
          yield* Effect.promise(async () => {
            for await (const chunk of input.stdin ?? []) chunks.push(chunk);
          });
          const tar = Buffer.concat(chunks);
          const directory = new TextDecoder()
            .decode(tar.subarray(0, 100))
            .replace(/\0.*$/su, "")
            .replace(/\/$/u, "");
          archives.set(directory, tar);
          return { status: 200, body: "" };
        }
        const body = input.body as { Cmd?: readonly string[] } | undefined;
        const cmd = body?.Cmd;
        if (
          input.method === "POST" &&
          input.path.endsWith("/exec") &&
          cmd?.[1]?.startsWith("exec-") === true
        ) {
          if (cmd[1] === "exec-supervisor") {
            const session = sessionFor(cmd[2] ?? "");
            const response = yield* request({
              ...originalContainer(input),
              body: { ...body, Cmd: cmd.slice(5) },
            });
            const id = (JSON.parse(response.body) as { Id: string }).Id;
            session.main = id;
            mains.set(id, session);
            return response;
          }
          const id = `lando-fixture-control-${next++}`;
          controls.set(id, cmd);
          return { status: 201, body: JSON.stringify({ Id: id }) };
        }
        const controlInspect = /^\/exec\/([^/]+)\/json$/u.exec(input.path);
        const id = controlInspect?.[1] === undefined ? undefined : decodeURIComponent(controlInspect[1]);
        if (id !== undefined && controls.has(id))
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: 0 }) };
        const response = yield* request(input);
        if (
          input.method === "GET" &&
          input.path.startsWith("/containers/") &&
          input.path.endsWith("/json") &&
          response.status === 200
        ) {
          const container = JSON.parse(response.body) as { Id?: string };
          if (container.Id !== undefined)
            names.set(
              container.Id,
              decodeURIComponent(input.path.slice("/containers/".length, -"/json".length)),
            );
        }
        const main = id === undefined ? undefined : mains.get(id);
        if (main !== undefined && response.status === 200) {
          const session = main;
          return {
            ...response,
            body: JSON.stringify({ ...JSON.parse(response.body), Running: !session.collected }),
          };
        }
        return response;
      }),
    stream: (input: EngineHttpRequest) => {
      const archive = /^\/containers\/[^/]+\/archive\?path=(.*)$/u.exec(input.path);
      if (input.method === "GET" && archive !== null) {
        const archivePath = decodeURIComponent(archive[1] ?? "");
        if (archivePath === "/tmp")
          return Stream.make(encodeUstarHeader({ name: "tmp/", size: 0, mode: 0o1777, typeflag: "5" }));
        const directory = archivePath.replace(/^\/tmp\//u, "");
        if (directory.startsWith("lando-exec-")) {
          const tar = archives.get(directory);
          return tar === undefined
            ? Stream.fail(
                new ProviderUnavailableError({
                  providerId: "fixture",
                  operation: "archive",
                  message: "Not found",
                  remediation: "Install the fixture helper.",
                  details: { status: 404 },
                }),
              )
            : Stream.make(tar);
        }
      }
      const match = /^\/exec\/([^/]+)\/start$/u.exec(input.path);
      const id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
      const cmd = id === undefined ? undefined : controls.get(id);
      if (cmd !== undefined)
        return Stream.fromEffect(
          Effect.gen(function* () {
            input.onResponseHead?.();
            const session = sessionFor(cmd[2] ?? "");
            const operation = cmd[1] === "exec-control" ? cmd[4] : cmd[1];
            if (operation === "exec-init" || operation === "exec-cleanup")
              return frame({ ok: true, state: "initialized" });
            if (operation === "ready")
              return frame({
                ok: true,
                state: session.cancelled ? "cancelled" : session.started ? "ready" : "initialized",
              });
            if (operation === "launch")
              return frame({ ok: true, state: session.cancelled ? "cancelled" : "running" });
            if (operation === "cancel") session.cancelled = true;
            const exitCode = yield* observedExit(session);
            if (operation === "collect") {
              session.collected = true;
              session.finish();
            }
            return frame({
              ok: true,
              state: session.cancelled ? "cancelled" : "finished",
              exitCode,
              joined: true,
            });
          }),
        );
      const session = id === undefined ? undefined : mains.get(id);
      if (session !== undefined)
        return Stream.suspend(() => {
          session.started = true;
          input.onResponseHead?.();
          return Stream.concat(
            stream(input),
            Stream.fromEffect(Effect.promise(() => session.collect)).pipe(Stream.drain),
          );
        });
      return stream(input);
    },
  });
};
