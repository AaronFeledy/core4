import { expect, test } from "bun:test";
import { runTooling } from "@lando/engine/operations/tooling";
import { attachEffectiveEvents } from "@lando/engine/planner/effective-events";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { EventServiceLive } from "@lando/engine/services/event-service";
import { configTranslators } from "@lando/lando3";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ConfigTranslateDocumentSetInput,
  ConfigTranslateSourceId,
  GlobalConfig,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  ConfigService,
  type ExecTarget,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Schema } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

/**
 * A converted Lando 3 app runs its tooling brackets through the real Lando 4
 * event runtime: pre before body, post only after a clean body, and a failing
 * step in either bracket is fatal.
 */
const LANDO3_APP = [
  "name: brackets",
  "services:",
  "  appserver: {type: 'php:8.3'}",
  "  node: {type: 'node:22'}",
  "tooling:",
  "  build:",
  "    service: node",
  "    cmd: [echo body-one, echo body-two]",
  "events:",
  "  pre-build:",
  "    - echo before",
  "  post-build:",
  "    - appserver: echo after",
  "    - echo tail",
].join("\n");

const convert = async (text: string): Promise<LandofileShape> => {
  const load = configTranslators.get("lando3");
  if (load === undefined) throw new Error("lando3 translator is not bundled");
  const translator = await load();
  const input = Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
    _tag: "landofile-document-set",
    documents: [
      {
        sourceId: ConfigTranslateSourceId.make(".lando.yml"),
        layerId: "canonical",
        path: ".lando.yml",
        mediaType: "application/yaml",
        contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
        bytes: Buffer.from(text).toString("base64"),
      },
    ],
    mode: "full",
    selectedSourceIds: [".lando.yml"],
    currentLowerV4Fragments: [],
    writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
  });
  const result = await Effect.runPromise(translator.translate(input));
  expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
  return Schema.decodeUnknownSync(LandofileShape)(result.outputs[0]?.fragment);
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-22T00:00:00Z"),
  source: "lando3-tooling-events-runtime.test",
  runtime: 4 as const,
};
const service = (name: string) => ({
  name: ServiceName.make(name),
  type: "compose",
  provider: ProviderId.make("test"),
  primary: name === "appserver",
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const run = (landofile: LandofileShape, failOn?: string) => {
  const executed: string[] = [];
  const record = (command: ReadonlyArray<string>, service: string) => {
    const label = `${service}: ${command[2]?.replace(/ "[$]@"$/u, "") ?? command.join(" ")}`;
    executed.push(label);
    return label === failOn ? 7 : 0;
  };
  const plan: AppPlan = {
    id: AppId.make("brackets"),
    name: "brackets",
    slug: "brackets",
    root: AbsolutePath.make(process.cwd()),
    provider: ProviderId.make("test"),
    services: {
      [ServiceName.make("appserver")]: service("appserver"),
      [ServiceName.make("node")]: service("node"),
    },
    routes: [],
    networks: [],
    fileSync: [],
    stores: [],
    metadata,
    extensions: {},
  };
  attachEffectiveTooling(plan, landofile.tooling ?? {});
  attachEffectiveEvents(plan, landofile.events ?? {});
  const provider = {
    ...TestRuntimeProvider,
    execStream: (target: ExecTarget, spec: CommandSpec) =>
      Effect.succeed({ exitCode: record(spec.command, String(target.service)) }),
  };
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = Layer.mergeAll(
    EventServiceLive,
    Layer.succeed(RedactionService, {
      forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
    }),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(ToolingEngine, {
      id: "recording",
      run: (invocation) =>
        Effect.sync(() => {
          const exitCode = record(invocation.commands[0] ?? [], String(invocation.service));
          return {
            tool: invocation.tool,
            service: String(invocation.service),
            exitCode,
            stdout: "",
            stderr: "",
          };
        }),
    }),
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(ConfigService, { load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("test")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  return Effect.runPromise(runTooling({ name: "build" }).pipe(Effect.provide(layer), Effect.either)).then(
    (result) => ({ result, executed }),
  );
};

test("runs converted brackets around the body in Lando 3 order and services", async () => {
  // Given
  const landofile = await convert(LANDO3_APP);
  // When
  const { result, executed } = await run(landofile);
  // Then
  expect(result._tag).toBe("Right");
  expect(executed).toEqual([
    "node: echo before",
    "node: echo body-one",
    "node: echo body-two",
    "appserver: echo after",
    "node: echo tail",
  ]);
});

test("stops before the body when a converted pre step fails", async () => {
  // Given
  const landofile = await convert(LANDO3_APP);
  // When
  const { result, executed } = await run(landofile, "node: echo before");
  // Then
  expect(result._tag).toBe("Left");
  expect(executed).toEqual(["node: echo before"]);
});

test("skips the post bracket when the converted body fails", async () => {
  // Given
  const landofile = await convert(LANDO3_APP);
  // When
  const { result, executed } = await run(landofile, "node: echo body-one");
  // Then
  expect(result).toMatchObject({ _tag: "Right", right: { exitCode: 7 } });
  expect(executed).toEqual(["node: echo before", "node: echo body-one"]);
});

test("fails the run and skips the tail when a converted post step fails", async () => {
  // Given
  const landofile = await convert(LANDO3_APP);
  // When
  const { result, executed } = await run(landofile, "appserver: echo after");
  // Then
  expect(result._tag).toBe("Left");
  expect(executed).toEqual([
    "node: echo before",
    "node: echo body-one",
    "node: echo body-two",
    "appserver: echo after",
  ]);
});
