import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Context, Effect } from "effect";
import { listMcpCatalog } from "../../src/cli/commands/meta/mcp-list-catalog";
import { readMcpToolingCatalog } from "../../src/cli/commands/meta/mcp-tooling-catalog";
import { CliInvocation } from "../../src/runtime/invocation-context";

test("retained tooling diagnostics reuse the session environment despite a different ambient environment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-mcp-captured-environment-"));
  const env = {
    SESSION_ONLY: "captured-private-canary",
    LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
    LANDO_USER_DATA_ROOT: join(cwd, "data"),
    LANDO_USER_CONF_ROOT: join(cwd, "conf"),
  };
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: [unparseable\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd,
        cacheRoot: env.LANDO_USER_CACHE_ROOT,
        env,
        landofile: { name: "captured" },
        entries: [
          {
            _tag: "Unavailable",
            id: "app:deploy",
            sourceKind: "tooling",
            visibility: "public",
            summary: "Deploy",
            diagnostic: { _tag: "FixtureError", message: "Invalid task" },
          },
        ],
      }),
    );
    const generation = { key: cwd, context: Context.makeUnsafe<unknown>(new Map()), commands: new Map() };
    const read = () =>
      Effect.runPromise(
        readMcpToolingCatalog(generation).pipe(
          Effect.provideService(CliInvocation, {
            cwd,
            env,
            io: createBufferedRendererIO(),
            setExitCode: () => undefined,
          }),
        ),
      );

    const first = await read();
    const repeated = await read();
    expect(first.unavailable).toMatchObject([{ commandId: "app:deploy", message: "Invalid task" }]);
    expect(repeated).toEqual(first);
    expect(JSON.stringify(repeated)).not.toContain(env.SESSION_ONLY);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([true, false])("list diagnostics redact invocation-only secrets (service=%j)", async (service) => {
  const secret = "list-captured-private-value";
  const pending = `fixture:${secret}`;
  const listing = listMcpCatalog({ commandEntries: [] }, { allow: [pending], deny: [], tooling: false }, [
    pending,
  ]).pipe(
    Effect.provideService(CliInvocation, {
      cwd: process.cwd(),
      env: { SESSION_API_TOKEN: secret },
      io: createBufferedRendererIO(),
      setExitCode: () => undefined,
    }),
  );
  const result = await Effect.runPromise(
    service ? listing.pipe(Effect.provideService(RedactionService, makeRedactionService())) : listing,
  );
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?._tag).toBe("McpPendingAllowance");
  expect(result.diagnostics[0]?.message).toContain("fixture:[redacted]");
  expect(result.diagnostics[0]?.remediation).toContain("fixture:[redacted]");
  expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
});
