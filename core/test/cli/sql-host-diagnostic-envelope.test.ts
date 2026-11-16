import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { prepareImportDump } from "@lando/sql/dump-file";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("SQL host read diagnostics reach the CLI envelope with a redacted path", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sql-envelope-"));
  const secret = "private-dump-token-2046";
  const path = join(root, `${secret}.sql`);
  const io = createBufferedRendererIO();
  let exitCode = 0;
  try {
    await runWithRendererHandling(
      Effect.scoped(
        prepareImportDump({
          file: path,
          appRoot: root,
          stagingDir: join(root, "stage"),
          completeness: undefined,
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      ),
      {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: "json",
        command: "db:import",
        resultSchema: Schema.Struct({ path: Schema.String, digest: Schema.String }),
        extraRedactionTokens: [secret],
        sourceEnv: {},
        io,
        formatError: ({ error }) => String(error),
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(exitCode).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({
      _tag: "DataTransferError",
      operation: "read",
      fromEndpoint: "hostPath",
      cause: {
        _tag: "FileIoError",
        operation: "read",
        reason: "not-found",
        path: join(root, "[redacted].sql"),
      },
    });
    expect(io.stdout()).not.toContain(secret);
    expect(io.stderr()).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
