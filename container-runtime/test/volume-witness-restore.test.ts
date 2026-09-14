import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppId } from "@lando/sdk/schema";
import { Effect, Schema, Stream } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { VOLUME_WITNESS_FILE } from "../src/volume-witness-helper.ts";

test.each(["copy", "native"] as const)(
  "%s restore preserves target witness and excludes source witness",
  async (snapshotMode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-witness-restore-"));
    const source = join(root, "source");
    const target = join(root, "target");
    let command: readonly string[] = [];
    const generation = "00000000-0000-4000-8000-000000000001";
    try {
      await mkdir(source);
      await mkdir(target);
      await writeFile(join(source, VOLUME_WITNESS_FILE), "source-generation");
      await writeFile(join(source, "payload"), "backup");
      await writeFile(join(target, VOLUME_WITNESS_FILE), "target-generation");
      await writeFile(join(target, "stale"), "stale");
      expect(await Bun.spawn(["tar", "-cf", join(root, "snap.tar"), "-C", source, "."]).exited).toBe(0);
      const plane = makeProviderDataPlane({
        providerId: "fixture",
        snapshotMode,
        redactDetails: (value) => value,
        api: {
          request: (input) => {
            if (input.path === "/volumes/actual") {
              return Effect.succeed({
                status: 200,
                body: JSON.stringify({
                  Name: "actual",
                  Labels: { "dev.lando.volume-instance": generation },
                }),
              });
            }
            if (input.path.startsWith("/containers/create"))
              command = Schema.decodeUnknownSync(Schema.Struct({ Cmd: Schema.Array(Schema.String) }))(
                input.body,
              ).Cmd;
            return Effect.succeed({ status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) });
          },
          stream: () => Stream.empty,
        },
      });
      await Effect.runPromise(
        Effect.scoped(
          plane.restoreVolume({
            target: { app: AppId.make("app"), store: "actual" },
            snapshot: { provider: "fixture", id: "snap" },
            expectedTargetGeneration: generation,
          }),
        ),
      );
      const localCommand = command.map((part) =>
        part
          .replaceAll("/lando-snapshots", root)
          .replaceAll("/lando-data", target)
          .replaceAll("/snapshot", source),
      );
      expect(await Bun.spawn([...localCommand], { stdout: "pipe", stderr: "pipe" }).exited).toBe(0);
      expect(await readFile(join(target, VOLUME_WITNESS_FILE), "utf8")).toBe("target-generation");
      expect(await readFile(join(target, "payload"), "utf8")).toBe("backup");
      expect(await Bun.file(join(target, "stale")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
