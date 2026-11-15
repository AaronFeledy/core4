import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppId } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { dataHelperImage, makeProviderDataPlane } from "../src/data-plane.ts";
import {
  classifyVolumeArchiveCommand,
  volumeArchiveDisposeCommand,
  volumeArchivePublishCommand,
  volumeSnapshotCaptureCommand,
  volumeSnapshotExtractCommand,
} from "../src/volume-archive.ts";
import { VOLUME_WITNESS_FILE } from "../src/volume-witness-helper.ts";
import { FakeEngine } from "./support/fake-engine.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const runLocally = async (
  cwd: string,
  command: ReadonlyArray<string>,
  replacements: Readonly<Record<string, string>>,
): Promise<void> => {
  const local = command.map((part) =>
    Object.entries(replacements).reduce((script, [from, to]) => script.replaceAll(from, to), part),
  );
  const child = Bun.spawn(["bash", "-c", local[2] ?? ""], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`helper failed (${exitCode}): ${await new Response(child.stderr).text()}`);
  }
};

test("native restore stages and publishes without touching the target witness", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-witness-restore-"));
  const volume = join(root, "volume");
  const staging = join(root, "snapshot");
  const target = join(root, "target");
  const commands: Array<ReadonlyArray<string>> = [];
  const pulled: string[] = [];
  const generation = "00000000-0000-4000-8000-000000000001";
  try {
    await mkdir(volume);
    await mkdir(staging);
    await mkdir(target);
    await writeFile(join(volume, VOLUME_WITNESS_FILE), "source-generation");
    await mkdir(join(volume, ".lando-witness-stage-target"));
    await writeFile(join(volume, ".lando-witness-stage-target", "record"), "stage");
    await writeFile(join(volume, "payload"), "backup");
    await writeFile(join(target, VOLUME_WITNESS_FILE), "target-generation");
    await writeFile(join(target, "stale"), "stale");

    // Capture outside the provider to model the committed snapshot image contents.
    await runLocally(volume, volumeSnapshotCaptureCommand(), {
      "/lando-data": volume,
      "/snapshot": staging,
    });
    expect(await Bun.file(join(staging, VOLUME_WITNESS_FILE)).exists()).toBe(false);

    const engine = new FakeEngine();
    engine.assets.volumes.set("actual", {
      Name: "actual",
      Labels: { "dev.lando.volume-instance": generation },
    });
    engine.assets.images.set("localhost/lando-volume-snapshot:snap", {
      Id: "sha256:native-snapshot",
      Size: 4096,
    });
    engine.observers.set("container.create", (input) => {
      commands.push(
        Schema.decodeUnknownSync(Schema.Struct({ Cmd: Schema.Array(Schema.String) }))(input.body).Cmd,
      );
    });
    const plane = makeProviderDataPlane({
      providerId: "fixture",
      capabilities: { volumeSnapshot: "native", volumeArchive: true },
      redactor: passthroughRedactor,
      api: engine.api,
      pullHelperImage: (ref) => {
        pulled.push(ref);
        const digest = ref.includes("@") ? ref.slice(ref.lastIndexOf("@") + 1) : "";
        return Effect.succeed({ ref, digest });
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        plane.restoreVolume({
          target: { app: AppId.make("app"), store: "actual" },
          snapshot: {
            provider: "fixture",
            id: "snap",
            digest: "sha256:native-snapshot",
            sizeBytes: 4096,
            format: "native",
          },
          expectedTargetGeneration: generation,
        }),
      ),
    );

    const extract = commands.find(
      (command) => classifyVolumeArchiveCommand(command).kind === "snapshot-extract",
    );
    if (extract === undefined) throw new Error("native restore did not stage the snapshot");
    const call = classifyVolumeArchiveCommand(extract);
    if (call.kind !== "snapshot-extract") throw new Error("unexpected helper classification");

    await runLocally(target, extract, { "/lando-data": target, "/snapshot": staging });
    await runLocally(target, volumeArchivePublishCommand(call.id), {
      "/lando-data": target,
      "/snapshot": staging,
    });
    await runLocally(target, volumeArchiveDisposeCommand(call.id), {
      "/lando-data": target,
      "/snapshot": staging,
    });

    expect(await readFile(join(target, VOLUME_WITNESS_FILE), "utf8")).toBe("target-generation");
    expect(await readFile(join(target, "payload"), "utf8")).toBe("backup");
    expect(await Bun.file(join(target, "stale")).exists()).toBe(false);
    expect(await Bun.file(join(target, volumeSnapshotExtractCommand(call.id)[2] ?? "")).exists()).toBe(false);
    expect(pulled).toContain(dataHelperImage.ref);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native restore refuses to publish with an unverified data helper", async () => {
  const commands: Array<ReadonlyArray<string>> = [];
  const generation = "00000000-0000-4000-8000-000000000002";
  const engine = new FakeEngine();
  engine.assets.volumes.set("actual", {
    Name: "actual",
    Labels: { "dev.lando.volume-instance": generation },
  });
  engine.assets.images.set("localhost/lando-volume-snapshot:snap", {
    Id: "sha256:native-snapshot",
    Size: 4096,
  });
  engine.observers.set("container.create", (input) => {
    commands.push(
      Schema.decodeUnknownSync(Schema.Struct({ Cmd: Schema.Array(Schema.String) }))(input.body).Cmd,
    );
  });
  const plane = makeProviderDataPlane({
    providerId: "fixture",
    capabilities: { volumeSnapshot: "native", volumeArchive: true },
    redactor: passthroughRedactor,
    api: engine.api,
    pullHelperImage: (ref) => {
      const digest = ref.includes("@") ? ref.slice(ref.lastIndexOf("@") + 1) : "";
      return Effect.succeed({
        ref,
        digest: ref.startsWith(dataHelperImage.ref) ? "sha256:0000000000000000" : digest,
      });
    },
  });

  const result = await Effect.runPromise(
    Effect.scoped(
      plane.restoreVolume({
        target: { app: AppId.make("app"), store: "actual" },
        snapshot: {
          provider: "fixture",
          id: "snap",
          digest: "sha256:native-snapshot",
          sizeBytes: 4096,
          format: "native",
        },
        expectedTargetGeneration: generation,
        overwrite: true,
      }),
    ).pipe(Effect.result),
  );

  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderInternalError" } });
  const kinds = commands.map((command) => classifyVolumeArchiveCommand(command).kind);
  expect(kinds).toContain("snapshot-extract");
  expect(kinds).not.toContain("publish");
  expect(kinds).not.toContain("dispose");
});
