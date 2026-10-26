import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, LandofileShape, LogSourceId, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { loadLandofileFile, loadLandofileLayers } from "../../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

for (const type of ["node:22", "compose"]) {
  for (const timestamps of [undefined, true]) {
    test.each(["file", "include", "layers"])(
      `preserves declared logs through %s compilation (${type}, timestamps=${timestamps})`,
      async (mode) => {
        // Given authored logs in a file, an include, or an included source with an overlay.
        const root = await mkdtemp(join(tmpdir(), "lando-declared-logs-"));
        const file = join(root, ".lando.yml");
        const logs = `    logs:\n      - path: /tmp/app.log\n        id: applog\n${timestamps === undefined ? "" : "        timestamps: true\n"}`;
        const service = `services:\n  app:\n    type: ${type}\n    image: node:22\n`;
        const inputs = {
          ports: makeTestLandofilePorts(root),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        };
        try {
          await Bun.write(
            file,
            `name: declared-logs\n${mode === "file" ? service + logs : "includes:\n  - logs.yml\n"}`,
          );
          if (mode !== "file") await Bun.write(join(root, "logs.yml"), service + logs);
          if (mode === "layers") {
            await Bun.write(
              join(root, ".lando.local.yml"),
              "services:\n  app:\n    logs:\n      - id: applog\n        path: /tmp/app.log\n        label: merged log\n",
            );
          }

          // When the actual file or layered loader finalizes the effective Landofile.
          const result = await Effect.runPromise(
            mode === "layers"
              ? loadLandofileLayers(root, file, inputs)
              : loadLandofileFile(file, undefined, inputs),
          );

          // Then decoded-only fields survive without being rejected as authored excess keys.
          expect(result.document.services?.[ServiceName.make("app")]?.logs).toEqual([
            {
              id: LogSourceId.make("applog"),
              path: AbsolutePath.make("/tmp/app.log"),
              stream: "stderr",
              strategy: "follow",
              required: false,
              timestamps: timestamps ?? false,
              ...(mode === "layers" ? { label: "merged log" } : {}),
            },
          ]);
          const encoded = Schema.encodeSync(LandofileShape)(result.document);
          expect(Schema.decodeUnknownSync(LandofileShape, { onExcessProperty: "error" })(encoded)).toEqual(
            result.document,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}
