import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataTransferError, FileIoError, safeFileIoError } from "@lando/sdk/errors";
import { VerifiedStreamError } from "@lando/sdk/verified-stream";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { writeDumpTransform } from "../src/compression.ts";
import { prepareImportDump } from "../src/dump-file.ts";
import { dumpTransferError } from "../src/dump-transfer-error.ts";

let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "lando-sql-persist-guard-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const failureOf = (exit: Exit.Exit<unknown, unknown>): DataTransferError => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(DataTransferError);
  if (!(error instanceof DataTransferError)) throw new Error("expected transfer failure");
  return error;
};

const expectGuard = (error: DataTransferError, message: string) => {
  expect(error).toMatchObject({
    operation: "persist",
    toEndpoint: expect.stringContaining(`hostPath:${root}`),
    message,
  });
  expect(error.cause).toBeInstanceOf(VerifiedStreamError);
  expect(error.cause).not.toBeInstanceOf(FileIoError);
  expect(error.cause).toMatchObject({ reason: "persist", message });
  expect(error.remediation).toMatch(/destination|preparation/iu);
  expect(error.remediation).not.toMatch(/space|storage|permission|quota|writable/iu);
};

test("compression preserves a non-regular destination diagnosis and the directory contents", async () => {
  const source = join(root, "source.sql");
  const destination = join(root, "destination");
  await fs.writeFile(source, "select 1;");
  await fs.mkdir(destination);
  await fs.writeFile(join(destination, "keep"), "original");

  const error = failureOf(
    await Effect.runPromiseExit(writeDumpTransform(source, destination, "gzip", "compress")),
  );

  expectGuard(error, "The destination exists and is not a regular file.");
  expect(await fs.readFile(join(destination, "keep"), "utf8")).toBe("original");
  expect((await fs.readdir(root)).sort()).toEqual(["destination", "source.sql"]);
  expect(await fs.readdir(destination)).toEqual(["keep"]);
});

for (const flow of ["compression", "import"] as const) {
  test.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER])(
    `${flow} preserves an invalid write count %s and cleans temporary files`,
    async (bytesWritten) => {
      const source = join(root, "source.sql");
      const destination = join(root, "destination");
      const stagingDir = join(root, "stage");
      if (flow === "compression") {
        await fs.writeFile(source, "select 1;");
        await fs.writeFile(destination, "original");
      }
      const originalOpen = fs.open;
      const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (String(path).startsWith(root) && String(path).includes(".tmp-")) {
          spyOn(handle, "write").mockImplementation(
            async <TBuffer extends NodeJS.ArrayBufferView | string>(buffer: TBuffer) => ({
              bytesWritten,
              buffer,
            }),
          );
        }
        return handle;
      });
      try {
        const effect =
          flow === "compression"
            ? writeDumpTransform(source, destination, "gzip", "compress").pipe(Effect.asVoid)
            : Effect.scoped(
                prepareImportDump({
                  file: "-",
                  appRoot: root,
                  stagingDir,
                  stdin: Stream.make(new TextEncoder().encode("select 1;")),
                  completeness: undefined,
                  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
                }),
              ).pipe(Effect.asVoid);
        const error = failureOf(await Effect.runPromiseExit(effect));

        expectGuard(error, "Failed to write artifact bytes.");
        if (flow === "compression") expect(await fs.readFile(destination, "utf8")).toBe("original");
        expect((await fs.readdir(root)).sort()).toEqual(
          flow === "compression" ? ["destination", "source.sql"] : ["stage"],
        );
        if (flow === "import") expect(await fs.readdir(stagingDir)).toEqual([]);
      } finally {
        open.mockRestore();
      }
    },
  );
}

test.each(["persist", "size", "checksum"] as const)(
  "SQL wrapping retains the full %s verification failure and its original diagnostics",
  (reason) => {
    const cause = Object.assign(new Error("preparation callback failed"), { code: "ENOSPC" });
    const original = new VerifiedStreamError({
      reason,
      message: "specific verification failure",
      expectedSha256: "expected digest",
      actualSha256: "actual digest",
      expectedSizeBytes: 17,
      actualSizeBytes: 11,
      cause,
    });

    const error = dumpTransferError("persist", join(root, "destination"), original);

    expect(error.cause).toBe(original);
    expect(error.toEndpoint).toBe(`hostPath:${join(root, "destination")}`);
    expect(error.message).toBe("specific verification failure");
    expect(error.cause).toMatchObject({
      reason,
      expectedSha256: "expected digest",
      actualSha256: "actual digest",
      expectedSizeBytes: 17,
      actualSizeBytes: 11,
      cause,
    });
    expect(error.remediation).not.toMatch(/space|storage|permission|quota|writable/iu);
  },
);

test("SQL wrapping forwards an already normalized ENOSPC cause by identity", () => {
  const path = join(root, "destination");
  const cause = safeFileIoError(
    "persist",
    path,
    Object.assign(new Error("private bytes"), { code: "ENOSPC" }),
  );
  const original = new VerifiedStreamError({
    reason: "persist",
    message: "Failed to persist artifact.",
    cause,
  });

  const error = dumpTransferError("persist", path, original);

  expect(error.cause).toBe(cause);
  expect(error.cause).toMatchObject({ operation: "persist", path, reason: "no-space" });
  expect(error.remediation).toBe(cause.remediation);
  expect(JSON.stringify(error)).not.toContain("private bytes");
});
