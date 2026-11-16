import { describe, expect, test } from "bun:test";
import type { DataPlaneHttpRequest } from "@lando/container-runtime/data-plane";
import { dataHelperImage, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { DataTransferError, VolumeOperationError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import type { VolumeArchiveImportSpec } from "@lando/sdk/services";
import { Effect, Exit, Option, Stream } from "effect";
import { classifyVolumeArchiveCommand } from "../src/volume-archive.ts";

const app = AppId.make("bridge-app");
const store = "data";
const target = { app, store };

const encoder = new TextEncoder();

/** A minimal one-member tar that the inline validator accepts. */
const safeArchive = (): Uint8Array => {
  const payload = encoder.encode("bridge");
  const header = new Uint8Array(512);
  const field = (offset: number, length: number, value: string) => {
    header.set(encoder.encode(value).subarray(0, length), offset);
  };
  field(0, 100, "payload");
  field(100, 8, "0000644\0");
  field(108, 8, "0000000\0");
  field(116, 8, "0000000\0");
  field(124, 12, `${payload.byteLength.toString(8).padStart(11, "0")}\0`);
  field(136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = new Uint8Array(Math.ceil(payload.byteLength / 512) * 512);
  padded.set(payload);
  return new Uint8Array([...header, ...padded, ...new Uint8Array(1024)]);
};

interface BridgeFake {
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly deletions: number;
  readonly api: Parameters<typeof makeProviderDataPlane>[0]["api"];
  readonly exitCode: (code: number) => void;
  readonly waitForever: () => void;
  readonly setExit: (kind: string, code: number) => void;
}

const makeBridgeFake = (): BridgeFake => {
  const commands: Array<ReadonlyArray<string>> = [];
  const containers = new Map<string, { command: ReadonlyArray<string>; exitCode: number }>();
  const exits = new Map<string, number>();
  let exitCode = 0;
  let hangExtract = false;
  let deletions = 0;
  const nameOf = (path: string, suffix: string) =>
    decodeURIComponent(path.slice("/containers/".length, -suffix.length));
  const request = (input: DataPlaneHttpRequest) => {
    if (input.path.startsWith("/containers/create?name=")) {
      const name = decodeURIComponent(input.path.slice("/containers/create?name=".length));
      const body = input.body as { Cmd?: ReadonlyArray<string> } | undefined;
      const command = body?.Cmd ?? [];
      commands.push(command);
      containers.set(name, { command, exitCode: 0 });
      return Effect.succeed({ status: 201, body: JSON.stringify({ Id: `${name}-id` }) });
    }
    if (input.path.startsWith("/containers/") && input.path.endsWith("/start")) {
      return Effect.succeed({ status: 204, body: "" });
    }
    if (input.path.startsWith("/containers/") && input.path.endsWith("/wait")) {
      const name = nameOf(input.path, "/wait");
      const container = containers.get(name);
      const kind = container === undefined ? "unknown" : classifyVolumeArchiveCommand(container.command).kind;
      const resolved = exits.get(kind) ?? exitCode;
      if (container !== undefined) container.exitCode = resolved;
      return hangExtract && kind === "extract"
        ? Effect.never
        : Effect.succeed({ status: 200, body: JSON.stringify({ StatusCode: resolved }) });
    }
    if (input.path.startsWith("/containers/") && input.path.endsWith("/json")) {
      const name = nameOf(input.path, "/json");
      return Effect.succeed({
        status: 200,
        body: JSON.stringify({ State: { ExitCode: containers.get(name)?.exitCode ?? exitCode } }),
      });
    }
    if (input.path.startsWith("/containers/") && input.method === "DELETE") {
      deletions += 1;
      return Effect.succeed({ status: 204, body: "" });
    }
    return Effect.succeed({ status: 200, body: "{}" });
  };
  const stream = (input: DataPlaneHttpRequest) => {
    if (input.path.includes("/attach?")) input.onResponseHead?.();
    return Stream.empty;
  };
  return {
    commands,
    get deletions() {
      return deletions;
    },
    api: { request, stream },
    exitCode: (code) => {
      exitCode = code;
    },
    waitForever: () => {
      hangExtract = true;
    },
    setExit: (kind: string, code: number) => {
      exits.set(kind, code);
    },
  };
};

const makePlane = (fake: BridgeFake) =>
  makeProviderDataPlane({
    providerId: "bridge",
    api: fake.api,
    capabilities: { volumeSnapshot: "none", volumeArchive: true },
    redactor: createStandaloneRedactor("secrets", { sourceEnv: {} }),
    pullHelperImage: (ref) => Effect.succeed({ ref, digest: dataHelperImage.digest }),
  });

const runImport = <E>(fake: BridgeFake, spec: VolumeArchiveImportSpec<E, never>, timeoutMs = 3000) =>
  Effect.runPromise(
    Effect.exit(Effect.scoped(makePlane(fake).importVolume(spec))).pipe(
      Effect.timeoutOption(`${timeoutMs} millis`),
    ),
  );

describe("volume archive bridge", () => {
  test("a source failure after valid tar bytes prevents publication and keeps the caller's error", async () => {
    const fake = makeBridgeFake();
    const sourceFailure = new DataTransferError({
      message: "source failed after the tar end markers",
      operation: "read",
      remediation: "Retry the transfer from a trusted source.",
    });
    let beforeCommit = 0;
    const outcome = await runImport(fake, {
      target,
      archive: Stream.concat(Stream.make(safeArchive()), Stream.fail(sourceFailure)),
      beforeCommit: Effect.sync(() => {
        beforeCommit += 1;
      }),
    });

    expect(
      Option.isSome(outcome) && Exit.isFailure(outcome.value) ? outcome.value.cause : undefined,
    ).toBeDefined();
    const failure =
      Option.isSome(outcome) && Exit.isFailure(outcome.value)
        ? outcome.value.cause.reasons.find((reason) => reason._tag === "Fail")
        : undefined;
    expect(failure?._tag === "Fail" ? failure.error : undefined).toBe(sourceFailure);
    expect(beforeCommit).toBe(0);
    const publishScript = fake.commands.some((command) =>
      command.join(" ").includes("lando-volume-helper:publish"),
    );
    expect(publishScript).toBe(false);
  });

  test("an unsafe archive is rejected before tar sees it", async () => {
    const fake = makeBridgeFake();
    const unsafe = safeArchive();
    encoder.encode("/absolute").forEach((byte, index) => {
      unsafe[512 - 512 + index] = byte;
    });
    // Rewrite the header with a valid checksum so only the path rule rejects it.
    const header = unsafe.subarray(0, 512);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);

    const outcome = await runImport(fake, {
      target,
      archive: Stream.make(unsafe),
      beforeCommit: Effect.void,
    });

    const failure =
      Option.isSome(outcome) && Exit.isFailure(outcome.value)
        ? outcome.value.cause.reasons.find((reason) => reason._tag === "Fail")
        : undefined;
    expect(failure?._tag === "Fail" ? failure.error : undefined).toBeInstanceOf(VolumeOperationError);
    expect(fake.commands.some((command) => command.join(" ").includes("lando-volume-helper:publish"))).toBe(
      false,
    );
  });

  test("an extractor that exits before reading does not hang the producer", async () => {
    const fake = makeBridgeFake();
    fake.exitCode(1);
    const endless = Stream.forever(Stream.make(new Uint8Array(4096)));
    const outcome = await runImport(
      fake,
      { target, archive: endless, beforeCommit: Effect.die("must not commit") },
      3000,
    );

    expect(Option.isSome(outcome)).toBe(true);
    const failure =
      Option.isSome(outcome) && Exit.isFailure(outcome.value)
        ? outcome.value.cause.reasons.find((reason) => reason._tag === "Fail")
        : undefined;
    expect(failure?._tag === "Fail" ? failure.error : undefined).toBeInstanceOf(VolumeOperationError);
    expect(fake.deletions).toBeGreaterThan(0);
  });

  test("interrupting a stalled extractor completes instead of hanging", async () => {
    const fake = makeBridgeFake();
    fake.waitForever();
    const outcome = await runImport(
      fake,
      {
        target,
        archive: Stream.forever(Stream.make(new Uint8Array(4096))),
        beforeCommit: Effect.die("must not commit"),
      },
      3000,
    );

    expect(outcome).toEqual(Option.none());
  });

  test("waits for a slow source to finish after tar accepted the archive", async () => {
    const fake = makeBridgeFake();
    let committed = false;
    const outcome = await runImport(fake, {
      target,
      archive: Stream.concat(
        Stream.make(safeArchive()),
        Stream.fromEffect(Effect.sleep("50 millis")).pipe(Stream.drain),
      ),
      beforeCommit: Effect.sync(() => {
        committed = true;
      }),
    });

    expect(Option.isSome(outcome) && Exit.isSuccess(outcome.value)).toBe(true);
    expect(committed).toBe(true);
    expect(fake.commands.some((command) => command.join(" ").includes("lando-volume-helper:publish"))).toBe(
      true,
    );
  });
});

describe("volume archive commit ordering", () => {
  test("a failed publication keeps the previous copy and never disposes it", async () => {
    const fake = makeBridgeFake();
    fake.setExit("publish", 1);
    let committed = 0;
    const outcome = await runImport(fake, {
      target,
      archive: Stream.make(safeArchive()),
      beforeCommit: Effect.sync(() => {
        committed += 1;
      }),
    });

    expect(Option.isSome(outcome) && Exit.isFailure(outcome.value)).toBe(true);
    expect(committed).toBe(1);
    const kinds = fake.commands.map((command) => classifyVolumeArchiveCommand(command).kind);
    expect(kinds).toContain("publish");
    expect(kinds).not.toContain("dispose");
  });
});
