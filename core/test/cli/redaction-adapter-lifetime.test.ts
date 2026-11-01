import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRemoteList } from "@lando/engine/operations/remote";
import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import { Effect } from "effect";
import { redactDetails, redactString } from "../../src/cli/redact.ts";
import { loadLando3TranslatorPorts } from "../../src/recipes/lando3-ports.ts";
import { runPostInit } from "../../src/recipes/post-init/runtime.ts";

test("pure translator and diagnostic adapters use an explicitly injected retained runtime redactor", async () => {
  // Given
  const owner = makeRedactionOwner();
  const redactor = await Effect.runPromise(owner.service.forProfile("secrets"));
  const ports = await loadLando3TranslatorPorts(serviceTypeFacts, redactor);
  try {
    // When
    await Effect.runPromise(owner.service.registerValues(["adapter-late-private-canary"]));
    // Then
    expect(ports.redactor.redactString("adapter-late-private-canary")).toBe("[redacted]");
    expect(redactString("adapter-late-private-canary", redactor)).toBe("[redacted]");
    expect(redactDetails({ detail: "adapter-late-private-canary" }, redactor)).toEqual({
      detail: "[redacted]",
    });
  } finally {
    owner.dispose();
  }
});

test("post-init failure diagnostics use the injected runtime redactor after late registration", async () => {
  // Given
  const owner = makeRedactionOwner();
  const redactor = await Effect.runPromise(owner.service.forProfile("secrets"));
  try {
    // When
    const failure = await runPostInit({
      runBun: async () => {
        throw new TypeError("Unexpected Bun action");
      },
      actions: [{ type: "command", cmd: "app:config:translate" }],
      destination: process.cwd(),
      recipeId: "redaction-test",
      appName: "redaction-test",
      answers: {},
      redact: redactor.redactString,
      commandRunner: async () => {
        await Effect.runPromise(owner.service.registerValues(["post-init-late-private-canary"]));
        return {
          exitCode: 1,
          stdout: "post-init-late-private-canary",
          stderr: "post-init-late-private-canary",
        };
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // Then
    expect(JSON.stringify(failure)).toContain("[redacted]");
    expect(JSON.stringify(failure)).not.toContain("post-init-late-private-canary");
  } finally {
    owner.dispose();
  }
});

test("remote output adapters use their runtime owner instead of an import-time standalone", async () => {
  // Given
  const owner = makeRedactionOwner();
  const root = await mkdtemp(join(tmpdir(), "lando-redaction-remote-owner-"));
  try {
    await Bun.write(
      join(root, ".lando.yml"),
      "name: redaction\nruntime: 4\nservices: {}\nremotes:\n  dev:\n    source: test\n    endpoint: remote-adapter-private-canary\n",
    );
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* owner.service.registerValues(["remote-adapter-private-canary"]);
        return yield* appRemoteList({ cwd: root });
      }).pipe(Effect.provideService(RedactionService, owner.service)),
    );
    // Then
    expect(result[0]?.config.endpoint).toBe("[redacted]");
  } finally {
    owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
import { serviceTypeFacts } from "@lando/service-lando";
