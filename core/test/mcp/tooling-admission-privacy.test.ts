import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBunShellScript } from "@lando/engine/operations/tooling-bun-script";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { parseScriptFile } from "@lando/landofile/bun-sh-discovery";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { dispatchTool } from "@lando/mcp/dispatch";
import { outcomeFromExit } from "@lando/mcp/execute";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import type { LandoEvent } from "@lando/sdk/events";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Result } from "effect";
import { mcpRegistryWithToolingEntries } from "../../src/cli/commands/meta/mcp";
import { environmentResolverLayer } from "../_support/value-contracts";

test("tooling events stay value-free when current admission newly marks retained input sensitive", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-sensitive-revision-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/private.bun.sh"),
      "# ---\n# flags:\n#   note:\n#     sensitive: true\n# ---\necho ran > body-ran.txt\n",
    );
    const script = await Effect.runPromise(
      parseScriptFile(join(root, ".lando/scripts/private.bun.sh"), "private.bun.sh"),
    );
    const retained = Result.getOrThrow(normalizeToolingInput("private", { flags: { note: {} } }));
    const command = { id: "app:private", summary: "Private", hidden: false, input: retained };
    const entry = mcpRegistryWithToolingEntries({ commandEntries: [] }, [command]).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing tooling projection");
    const redaction = makeRedactionService();
    const events: LandoEvent[] = [];
    let accepted = 0;
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* dispatchTool(
          { toolId: command.id, input: { flags: { note: root }, appPath: root } },
          {
            registry: new Map([[command.id, entry]]),
            effective: new Set([command.id]),
            allowlistSource: "tooling",
            redactor: yield* redaction.forProfile("secrets", { sourceEnv: {} }),
            resultRedactor: (tokens) =>
              redaction.forProfile("secrets", { authoritativeTokens: tokens, sourceEnv: {} }),
            execute: () =>
              runBunShellScript(script, root, {
                input: { _tag: "NamedMaps", flags: { note: root }, args: {} },
                expectedInputRevision: retained.revision,
              }).pipe(
                Effect.map((value) => {
                  accepted++;
                  return resolveCommandCompletion(command.id, value);
                }),
                Effect.exit,
                Effect.flatMap(outcomeFromExit),
                Effect.provide(
                  Layer.mergeAll(
                    BunProcessRunner.layer,
                    PrivateFileAccessService.layer,
                    environmentResolverLayer(),
                  ),
                ),
              ),
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        ).pipe(Effect.result);
      }).pipe(Effect.provideService(RedactionService, redaction)),
    );
    // Then
    expect(accepted).toBe(0);
    expect(await Bun.file(join(root, "body-ran.txt")).exists()).toBe(false);
    const call = Result.getOrThrow(result);
    expect(call).toMatchObject({
      ok: false,
      envelope: { ok: false, error: { _tag: "ToolingInputError" } },
    });
    expect(JSON.stringify(call.envelope)).not.toContain(root);
    const redactor = await Effect.runPromise(redaction.forProfile("secrets", { sourceEnv: {} }));
    expect(redactor.redactString(root)).toBe("[redacted]");
    expect(events.map((event) => event._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    for (const event of events) {
      expect(event).not.toHaveProperty("appRef");
      expect(JSON.stringify(event)).not.toContain(root);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
