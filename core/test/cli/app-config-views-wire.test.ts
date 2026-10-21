import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
          .pipe(Effect.provide(layer)),
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
