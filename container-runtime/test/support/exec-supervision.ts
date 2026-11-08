import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { ContainerHelperUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type ContainerHelperTarget, PortablePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { engineInfoArchitecture, hostProxyContainerTargets } from "../../src/capabilities.ts";
import { containerHelperDelivery } from "../../src/container-helper.ts";
import type { EngineHttpApi, EngineHttpRequest } from "../../src/engine-api.ts";
import type { ResolveContainerHelper } from "../../src/log-source-binding.ts";
import { commonContainerLabels } from "../../src/plan.ts";

const root = mkdtempSync(join(tmpdir(), "lando-supervised-exec-fixture-"));
const path = join(root, "lando-container-helper");
const bytes = new TextEncoder().encode("supervised-exec-protocol-fixture");
writeFileSync(path, bytes);
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const artifact = {
  target: { os: "linux", arch: "x64" } as const,
  path: AbsolutePath.make(path),
  digest: sha256Hex(bytes),
};
const resolveHelper: ResolveContainerHelper = (target) => Effect.succeed({ ...artifact, target });
export const fixtureHelperOptions = { resolveContainerHelper: resolveHelper, helperTarget: artifact.target };
export const fixtureHelperMount = {
  type: "bind" as const,
  origin: "integration" as const,
  source: root,
  target: "/run/lando/helper",
  readOnly: true,
  realization: "passthrough" as const,
};
export const fixtureContainerLabels: typeof commonContainerLabels = (plan, service) =>
  commonContainerLabels(plan, {
    ...service,
    mounts: [
      ...service.mounts,
      { ...fixtureHelperMount, target: PortablePath.make(fixtureHelperMount.target) },
    ],
  });

export const fixtureHelperOptionsFor = (api: EngineHttpApi | undefined) => {
  if (api !== undefined && "info" in api && Effect.isEffect(api.info))
    Object.assign(api, {
      info: api.info.pipe(
        Effect.map((info) => ({
          Architecture: "amd64",
          ...(typeof info === "object" && info !== null ? info : {}),
        })),
      ),
    });
  return fixtureHelperOptions;
};
const installed = new WeakSet<EngineHttpApi>();

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
    const target = hostProxyContainerTargets(engineInfoArchitecture(yield* api.info))[0];
    if (target === undefined)
      return yield* Effect.fail(new Error("Test daemon did not report its container architecture."));
    return { resolveContainerHelper: resolveBuiltContainerHelperForTest, helperTarget: target };
  });

export const supervisedExecFixtureOptions = (
  api: EngineHttpApi | undefined,
): {
  readonly resolveContainerHelper?: ResolveContainerHelper;
  readonly helperTarget?: ContainerHelperTarget;
} => (api !== undefined && installed.has(api) ? fixtureHelperOptions : {});

const ExecBody = Schema.Struct({ Cmd: Schema.Array(Schema.String) });
const Container = Schema.Struct({ Id: Schema.optionalKey(Schema.String) });

/** Translate the real framed exec boundary into the existing fake workload. */
export const installSupervisedExecFixture = (api: EngineHttpApi): void => {
  if (installed.has(api)) return;
  const { request, stream } = api;
  if (request === undefined || stream === undefined)
    throw new TypeError("Supervised exec fixture requires request and stream.");
  installed.add(api);
  if ("info" in api && Effect.isEffect(api.info))
    Object.assign(api, {
      info: api.info.pipe(
        Effect.map((info) => ({
          ...(typeof info === "object" && info !== null ? info : {}),
          Architecture: "amd64",
        })),
      ),
    });
  const names = new Map<string, string>();
  const mains = new Set<string>();
  Object.assign(api, {
    request: (input: EngineHttpRequest) =>
      Effect.gen(function* () {
        const body = Schema.decodeUnknownOption(ExecBody)(input.body);
        if (body._tag === "Some" && body.value.Cmd[1] === "exec-run") {
          const match = /^\/containers\/([^/]+)\/exec$/.exec(input.path);
          const id = decodeURIComponent(match?.[1] ?? "");
          const response = yield* request({
            ...input,
            path: `/containers/${encodeURIComponent(names.get(id) ?? id)}/exec`,
            body: {
              ...(typeof input.body === "object" && input.body !== null ? input.body : {}),
              Cmd: body.value.Cmd.slice(body.value.Cmd.indexOf("--", 4) + 1),
            },
          });
          const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Container))(response.body);
          if (decoded.Id !== undefined) mains.add(decoded.Id);
          return response;
        }
        const response = yield* request(input);
        if (
          input.method === "GET" &&
          input.path.startsWith("/containers/") &&
          input.path.endsWith("/json") &&
          response.status === 200
        ) {
          const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Container))(response.body);
          if (decoded.Id !== undefined) names.set(decoded.Id, decodeURIComponent(input.path.slice(12, -5)));
          const delivery = containerHelperDelivery(artifact);
          return {
            ...response,
            body: JSON.stringify({
              ...JSON.parse(response.body),
              Mounts: [{ Source: delivery.source, Destination: delivery.target, RW: false }],
            }),
          };
        }
        return response;
      }),
    stream: (input: EngineHttpRequest) => {
      const id = /^\/exec\/([^/]+)\/start$/.exec(input.path)?.[1];
      if (id === undefined || !mains.has(decodeURIComponent(id)) || input.stdin === undefined)
        return stream(input);
      const control = input.stdin;
      const stdin: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for await (const frame of control) {
            switch (frame[0]) {
              case 0:
                yield frame.subarray(5);
                break;
              case 1:
              case 2:
                return;
              default:
                throw new TypeError("Invalid exec control frame.");
            }
          }
        },
      };
      return stream({ ...input, stdin });
    },
  });
};
