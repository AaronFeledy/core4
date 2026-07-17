import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import { type Context, Effect, Layer } from "effect";

import { InteractionService, Renderer } from "@lando/sdk/services";

import { makeInteractionPrompter } from "../../src/interaction/prompter.ts";
import { makeInteractionService } from "../../src/interaction/service.ts";

type RendererService = Context.Tag.Service<typeof Renderer>;

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Readable.from(lines.map((line) => `${line}\n`));

const neverStdin = (): NodeJS.ReadableStream =>
  new Readable({
    read() {
      // never push — readLine blocks until interrupted
    },
  });

const capturingRenderer = (id = "plain") => {
  let out = "";
  let err = "";
  const service: RendererService = {
    id,
    capabilities: { color: false, interactive: false, animation: false, notifications: false },
    message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    output: {
      stdout: (chunk: string) =>
        Effect.sync(() => {
          out += chunk;
        }),
      stderr: (chunk: string) =>
        Effect.sync(() => {
          err += chunk;
        }),
    },
  };
  return { service, out: () => out, err: () => err };
};

const buildPrompter = (
  stdin: NodeJS.ReadableStream,
  renderer?: RendererService,
  stdout?: NodeJS.WritableStream,
) => {
  const interaction = makeInteractionService({ stdin, ...(stdout === undefined ? {} : { stdout }) });
  let layer = Layer.succeed(InteractionService, interaction);
  if (renderer !== undefined) {
    layer = Layer.merge(layer, Layer.succeed(Renderer, renderer));
  }
  return Effect.runPromise(makeInteractionPrompter.pipe(Effect.provide(layer)));
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

  test("a captured Renderer receives prompt chrome on stdout", async () => {
    const renderer = capturingRenderer();
    const prompter = await buildPrompter(scriptedStdin(["typed"]), renderer.service);
    await prompter.promptAll([{ name: "app", type: "text", message: "App name?" }], { interactive: true });
    expect(renderer.out()).toContain("App name?");
  });

  test("promptAll rejects with InteractionRequiredError on a missing non-interactive answer", async () => {
    const prompter = await buildPrompter(neverStdin());
    await expect(
      prompter.promptAll([{ name: "app", type: "text", message: "Name?" }], { interactive: false }),
    ).rejects.toMatchObject({ _tag: "InteractionRequiredError" });
  });
});
