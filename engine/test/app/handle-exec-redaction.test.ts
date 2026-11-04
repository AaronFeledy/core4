import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";
import { Context, DateTime, Effect } from "effect";
import { type AppHandleRuntimeServices, makeAppHandle } from "../../src/app/handle.ts";
import { makeAppLifecycle } from "../../src/app/lifecycle.ts";
import { type AppOperations, appOperations } from "../../src/app/operations.ts";

const plan: AppPlan = {
  id: AppId.make("handle-exec-redaction"),
  name: "handle-exec-redaction",
  slug: "handle-exec-redaction",
  root: AbsolutePath.make("/handle-exec-redaction"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
  extensions: {},
};

test("App.exec masks registered values in the stderr it forwards to the renderer", async () => {
  // Given: exec returns stderr holding a value registered while the command ran.
  const secret = "handle-exec-secret-0d1f9a";
  const written: Array<string | Uint8Array> = [];
  const renderer = {
    output: { stderr: (chunk: string | Uint8Array) => Effect.sync(() => written.push(chunk)) },
  };
  const redaction = makeRedactionService();
  const runtime = Context.makeUnsafe<AppHandleRuntimeServices>(
    new Map<string, unknown>([
      [RedactionService.key, redaction],
      [Renderer.key, renderer],
    ]),
  );
  const ops: AppOperations = {
    ...appOperations,
    execApp: () =>
      redaction.registerValues([secret]).pipe(
        Effect.as({
          app: plan.name,
          service: "web",
          command: ["printenv"],
          exitCode: 0,
          stdout: "",
          stderr: `token=${secret}\n`,
        }),
      ),
  };

  // When: the library handle runs exec.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* makeAppLifecycle(yield* Effect.scope);
        const handle = makeAppHandle(
          { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
          runtime,
          ops,
          lifecycle,
        );
        yield* handle.exec({ command: ["web", "--", "printenv"] });
      }),
    ),
  );

  // Then: the forwarded stderr holds the redaction sentinel, never the value.
  const text = written
    .map((chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)))
    .join("");
  expect(text).toContain("[redacted]");
  expect(text).not.toContain(secret);
});
