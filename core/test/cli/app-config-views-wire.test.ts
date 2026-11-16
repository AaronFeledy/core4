import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ConfigLayer from "@lando/engine/services/config";
import { LandofileService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { appConfigMcpSpecs } from "../../src/cli/command-specs/app/config/index.ts";
import { testStateStoreLayer } from "../_support/landofile-layer.ts";
import { withCwd } from "../_support/temp-cwd.ts";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const canary = "view-wire-lower-canary=retained";
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-views-wire-"));
  await writeFile(
    join(root, ".lando.base.yml"),
    `name: wire\nservices:\n  web:\n    environment: [PASSWORD=${canary}]\nx-directive: !override\n  TOKEN: ${canary}\n`,
  );
  await writeFile(
    join(root, ".lando.yml"),
    `services:\n  web:\n    environment:\n      PASSWORD: top-wire-canary\nx-echo: ${canary}\n`,
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each(["raw", "merged", "resolved"])(
  "redacts %s JSON and YAML before full or projected emission",
  async (source) => {
    for (const format of ["json", "yaml"]) {
      for (const projection of [[], ["--path", "x-echo"]]) {
        const process = Bun.spawn({
          cmd: [
            Bun.which("bun") ?? "bun",
            cli,
            "app:config",
            "--source",
            source,
            `--format=${format}`,
            ...projection,
          ],
          cwd: root,
          env: {
            ...globalThis.process.env,
            LANDO_USER_CONF_ROOT: join(root, "conf"),
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, output, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(output).not.toContain(canary);
        expect(output).not.toContain("top-wire-canary");
        expect(output).toContain("[redacted]");
        expect(output).not.toContain("redactionTokens");
        if (format === "yaml")
          expect(output.startsWith("apiVersion:")).toBe(source !== "resolved" || projection.length > 0);
      }
    }
  },
);

test.each(["app:config:view", "app:config:get"])(
  "executes %s with forwarded source/path while refusing write-subcommand injection",
  async (id) => {
    const spec = appConfigMcpSpecs.find((entry) => entry.id === id);
    if (spec === undefined) throw new Error("Missing read-only projection");
    const layer = Layer.merge(
      testStateStoreLayer,
      Layer.succeed(
        LandofileService,
        LandofileService.of({ discover: Effect.die("Raw MCP must not resolve.") }),
      ),
    );
    const result = await withCwd(root, () =>
      Effect.runPromise(
        spec
          .run({ args: { subcommand: "set" }, flags: { source: "raw", path: "x-echo" } })
          .pipe(Effect.provide(layer), Effect.provide(ConfigLayer.layer)),
      ),
    );
    expect(result).toMatchObject(
      id.endsWith(":get")
        ? {
            source: "raw",
            subcommand: "get",
            key: "x-echo",
            value: [{ layer: "base" }, { layer: "canonical", document: canary }],
          }
        : {
            source: "raw",
            path: "x-echo",
            layers: [{ layer: "base" }, { layer: "canonical", document: canary }],
          },
    );
  },
);

test("keeps deferred reference descriptors under secret-named environment keys", async () => {
  // Given: an environment map that names a secret reference and a free-text value.
  const root = await mkdtemp(join(tmpdir(), "lando-views-wire-refs-"));
  await writeFile(
    join(root, ".lando.yml"),
    `name: refs\nservices:\n  web:\n    type: "nginx:1.27"\n    environment:\n      DB_PASSWORD: '\${secret:DB_PASSWORD}'\n      API_TOKEN: hunter2\n      PLAIN: visible\n`,
  );
  try {
    for (const format of ["json", "yaml"]) {
      // When
      const spawned = Bun.spawn({
        cmd: [Bun.which("bun") ?? "bun", cli, "app:config", `--format=${format}`],
        cwd: root,
        env: {
          ...globalThis.process.env,
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, stderr] = await Promise.all([
        spawned.exited,
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
      ]);
      // JSON wraps the view in the result envelope; YAML prints the document itself.
      const parsed = Bun.YAML.parse(output) as {
        ok?: boolean;
        result?: { landofile: { services: { web: { environment: Record<string, unknown> } } } };
        services?: { web: { environment: Record<string, unknown> } };
      };
      const environment =
        format === "json"
          ? parsed.result?.landofile.services.web.environment
          : parsed.services?.web.environment;
      // Then: the descriptor stays decodable, the plain literal names nothing, and free text masks.
      expect({ code, stderr, ok: format === "json" ? parsed.ok : true }).toEqual({
        code: 0,
        stderr: "",
        ok: true,
      });
      expect(environment).toEqual({
        DB_PASSWORD: { _tag: "SecretRef", reference: "DB_PASSWORD" },
        API_TOKEN: "[redacted]",
        PLAIN: "visible",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
