import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";

import { type Context, Effect, Layer } from "effect";

import { InteractionService, Renderer } from "@lando/sdk/services";

import { makeInteractionPrompter, makePromiseInteractionPrompter } from "../../src/interaction/prompter.ts";
import { makeInteractionService } from "../../src/interaction/service.ts";

type RendererService = Context.Service.Shape<typeof Renderer>;

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Object.assign(Readable.from(lines.map((line) => `${line}\n`)), { isTTY: true });

const neverStdin = (): NodeJS.ReadableStream =>
  new Readable({
    read() {
      // never push — readLine blocks until interrupted
    },
  });

const capturingRenderer = (id = "plain") => {
  let out = "";
  let err = "";
  const service: RendererService = Renderer.of({
    id,
    capabilities: { color: false, interactive: false, animation: false, notifications: false },
    message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    output: {
      stdout: (chunk) =>
        Effect.sync(() => {
          out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        }),
      stderr: (chunk) =>
        Effect.sync(() => {
          err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        }),
    },
  });
  return { service, out: () => out, err: () => err };
};

const buildPrompter = (
  stdin: NodeJS.ReadableStream,
  renderer?: RendererService,
  stdout?: NodeJS.WritableStream,
) => {
  const stderr = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { isTTY: true },
  );
  const interaction = makeInteractionService({ stdin, stderr, ...(stdout === undefined ? {} : { stdout }) });
  let layer = Layer.succeed(InteractionService, InteractionService.of(interaction));
  if (renderer !== undefined) {
    layer = Layer.merge(layer, Layer.succeed(Renderer, Renderer.of(renderer)));
  }
  return Effect.runPromise(makeInteractionPrompter().pipe(Effect.provide(layer)));
};

describe("makeInteractionPrompter — Promise adapter over InteractionService", () => {
  test("promptAll resolves explicit answers without prompting", async () => {
    const prompter = await buildPrompter(neverStdin());
    const answers = await prompter.promptAll([{ name: "app", type: "text", message: "Name?" }], {
      answers: { app: "blog" },
      interactive: false,
    });
    expect(answers).toEqual({ app: "blog" });
  });

  test("promptAll reads scripted stdin interactively", async () => {
    const prompter = await buildPrompter(scriptedStdin(["typed-value"]));
    const answers = await prompter.promptAll([{ name: "app", type: "text", message: "Name?" }], {
      interactive: true,
    });
    expect(answers).toEqual({ app: "typed-value" });
  });

  test("confirm returns the scripted boolean answer", async () => {
    const prompter = await buildPrompter(scriptedStdin(["y"]));
    const ok = await prompter.confirm({ message: "Continue?", name: "go", interactive: true });
    expect(ok).toBe(true);
  });

  test("confirm resolves the default under --yes without prompting", async () => {
    const prompter = await buildPrompter(neverStdin());
    const ok = await prompter.confirm({ message: "Continue?", name: "go", default: true, yes: true });
    expect(ok).toBe(true);
  });

  test.each([false, true])(
    "invocation abort cancels a pending confirmation (captured=%s)",
    async (captured) => {
      const waitingForInput = Promise.withResolvers<void>();
      const controller = new AbortController();
      let released = false;
      const service = InteractionService.of({
        ...makeInteractionService(),
        confirm: () =>
          Effect.sync(() => waitingForInput.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
      });
      const prompter = captured
        ? await Effect.runPromise(
            makeInteractionPrompter(controller.signal).pipe(
              Effect.provideService(InteractionService, InteractionService.of(service)),
            ),
          )
        : makePromiseInteractionPrompter(service, controller.signal);

      const confirmation = prompter.confirm({ name: "create", message: "Create files?", interactive: true });
      await waitingForInput.promise;
      controller.abort();
      await expect(confirmation).rejects.toMatchObject({ _tag: "InteractionCancelledError" });
      expect(released).toBe(true);
    },
  );

  test("a captured Renderer receives prompt chrome on stderr only", async () => {
    const renderer = capturingRenderer();
    const prompter = await buildPrompter(scriptedStdin(["typed"]), renderer.service);
    await prompter.promptAll([{ name: "app", type: "text", message: "App name?" }], { interactive: true });
    expect(renderer.err()).toContain("App name?");
    expect(renderer.out()).toBe("");
  });

  test("promptAll rejects with InteractionRequiredError on a missing non-interactive answer", async () => {
    const prompter = await buildPrompter(neverStdin());
    await expect(
      prompter.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: false }),
    ).rejects.toMatchObject({ _tag: "InteractionRequiredError" });
  });
});
