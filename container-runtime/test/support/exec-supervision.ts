import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath, type ContainerHelperTarget, PortablePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { engineInfoArchitecture, hostProxyContainerTargets } from "../../src/capabilities.ts";
import { resolveContainerHelper } from "../../src/container-helper/assets.ts";
import {
  CONTAINER_HELPER_COMMANDS,
  CONTAINER_HELPER_PROFILE_TARGET,
  containerHelperDelivery,
  containerHelperProfileStubPath,
} from "../../src/container-helper.ts";
import { prepareContainerHelperMounts } from "../../src/container-helper-mount.ts";
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
export const fixtureHelperCommandMounts = CONTAINER_HELPER_COMMANDS.map((name) => ({
  type: "bind" as const,
  origin: "integration" as const,
  source: join(fixtureHelperMount.source, "shims", name),
  target: PortablePath.make(`/usr/local/bin/${name}`),
  readOnly: true,
  realization: "passthrough" as const,
}));
export const fixtureHelperProfileStubBind = `${containerHelperProfileStubPath(artifact)}:${CONTAINER_HELPER_PROFILE_TARGET}:ro`;

/** Labels of a container created with the fixture helper, lowered by the provider's own mount preparation. */
export const fixtureContainerLabels: typeof commonContainerLabels = (plan, service) => {
  const prepared = Effect.runSync(
    prepareContainerHelperMounts(
      { ...plan, services: { [service.name]: service } },
      { ...fixtureHelperOptions, ctx: { providerId: "podman", remediation: "Retry.", env: {} } },
    ),
  );
  return commonContainerLabels(plan, prepared.services[service.name] ?? service);
};

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

/** The real resolver, so live services bind the published command shims and profile hook. */
export const resolveBuiltContainerHelperForTest: ResolveContainerHelper = (target) =>
  resolveContainerHelper(target, { standalone: false });

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
