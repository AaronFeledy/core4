import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema, Stream } from "effect";
import { runCli } from "../../src/cli/run.ts";
import { bundledRecipe } from "../_support/bundled-recipe.ts";

test.each([
  { pin: "npm@10.10.0", prefix: ["npm", "exec", "--no", "--"] },
  { pin: "pnpm@10.10.0", prefix: ["pnpm", "exec"] },
  { pin: "yarn@4.9.2", prefix: ["yarn", "run"] },
  { pin: "bun@1.2.0", prefix: ["npm", "exec", "--no", "--"] },
])(
  "runs the Next.js recipe alias with $pin from the caller's directory",
  async ({ pin, prefix }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-recipe-local-bin-")));
    const caller = join(root, "caller");
    const calls: unknown[] = [];
    const providerRegistry = Layer.succeed(RuntimeProviderRegistry, {
      readAppliedPlanStrict: () => Effect.succeed(undefined),
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
      select: () =>
        Effect.succeed({
          ...TestRuntimeProvider,
          execStream: (target, spec) =>
            Stream.suspend(() => {
              calls.push({ service: target.service, cmd: spec.command, cwd: spec.cwd });
              return Stream.make({ exitCode: 0 });
            }),
        }),
    });
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];
    try {
      await mkdir(caller);
      await mkdir(join(root, "frontend"));
      const recipe = bundledRecipe("nextjs");
      const result = await Effect.runPromise(
        recipe.decomposer({ redactor: createStandaloneRedactor("secrets") }).decompose({
          producer: recipe.producer,
          options: { ...recipe.defaults, database: "none" },
          secrets: {},
        }),
      );
      const fragment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        result.fragment,
      );
      const services = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      )(fragment.services);
      await writeFile(
        join(root, ".lando.yml"),
        Bun.YAML.stringify(
          {
            ...fragment,
            name: "next-local",
            services: { ...services, web: { ...services.web, packageRoot: "frontend" } },
          },
          null,
          2,
        ),
      );
      await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
      await writeFile(join(root, "frontend", "package.json"), JSON.stringify({ packageManager: pin }));
      if (pin.startsWith("yarn")) await writeFile(join(root, "frontend", ".yarnrc.yml"), "nodeLinker: pnp\n");

      await runCli({
        argv: ["next", "dev", "--port", "3001"],
        rootUrl: "",
        context: {
          cwd: caller,
          io,
          providerRegistry,
          setExitCode: (code) => exitCodes.push(code),
          env: {
            ...process.env,
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          },
        },
      });

      expect(
        exitCodes.filter((code) => code !== 0),
        io.stderr(),
      ).toEqual([]);
      expect(calls).toEqual([
        { service: "web", cmd: [...prefix, "next", "dev", "--port", "3001"], cwd: "/app/caller" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
