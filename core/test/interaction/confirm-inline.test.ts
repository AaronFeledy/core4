import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { loadInteractivePromptDriver } from "@lando/renderer-lando";
import { InteractionCancelledError } from "@lando/sdk/errors";
import { resetInteractivePromptDegradationForTest } from "../../src/interaction/interactive-driver.ts";
import { makePromiseInteractionPrompter } from "../../src/interaction/prompter.ts";
import {
  makeDefaultResolveInteractionDriver,
  makeInteractionService,
} from "../../src/interaction/service.ts";

const fixture = (signal?: AbortSignal) => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const writes: string[] = [];
  const notices: string[] = [];
  const waiting = Promise.withResolvers<void>();
  const stderr = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        if (String(chunk).includes("CONFIRM_TOKEN")) waiting.resolve();
        callback();
      },
    }),
    { isTTY: true },
  );
  const service = makeInteractionService({
    stdin,
    stderr,
    resolveDriver: makeDefaultResolveInteractionDriver({
      env: {},
      importRendererPlugin: async () => ({ loadInteractivePromptDriver }),
      debug: async (message) => {
        notices.push(message);
      },
    }),
  });
  return {
    stdin,
    stderr,
    writes,
    notices,
    waiting,
    prompter: makePromiseInteractionPrompter(service, signal),
  };
};

afterEach(resetInteractivePromptDegradationForTest);

describe("rich-driver confirmations use the shared inline reader", () => {
  test.each([
    { answer: "y", default: false, expected: true },
    { answer: "", default: false, expected: false },
    { answer: "n", default: true, expected: false },
    { answer: "", default: true, expected: true },
    { answer: "\nn", expected: false },
  ])("preserves buffered questionnaire input for %j", async (spec) => {
    // Given one chunk containing a questionnaire answer and the later decision.
    const h = fixture();
    h.stdin.end(`questionnaire-value\n${spec.answer}\n`);
    try {
      await h.prompter.promptAll([{ name: "token", type: "secret", message: "QUESTIONNAIRE_TOKEN" }], {
        mode: "interactive",
      });
      h.stderr.write("\nPREPARED_CONTEXT\n");
      const before = h.writes.join("");

      // When the same service asks a rich-driver confirmation.
      const answer = await h.prompter.confirm({
        name: "decision",
        message: "CONFIRM_TOKEN",
        mode: "interactive",
        ...(spec.default === undefined ? {} : { default: spec.default }),
      });

      // Then the buffered decision wins without a new reader, repaint, or degradation notice.
      expect(answer).toBe(spec.expected);
      expect(h.writes.join("").startsWith(before)).toBe(true);
      expect(h.writes.join("")).not.toContain("\x1b[");
      expect(h.notices).toEqual([]);
      expect(h.stdin.listenerCount("data")).toBe(0);
    } finally {
      h.stdin.destroy();
      h.stderr.destroy();
    }
  });

  test("invocation abort cancels a pending inline decision and detaches its reader", async () => {
    // Given the actual rich driver and a confirmation waiting on line input.
    const controller = new AbortController();
    const h = fixture(controller.signal);
    const answer = h.prompter.confirm({
      name: "decision",
      message: "CONFIRM_TOKEN",
      default: false,
      mode: "interactive",
    });
    try {
      await h.waiting.promise;

      // When the invocation is cancelled.
      controller.abort();

      // Then cancellation remains typed and the shared stdin listener is released.
      await expect(answer).rejects.toBeInstanceOf(InteractionCancelledError);
      expect(h.stdin.listenerCount("data")).toBe(0);
      expect(h.notices).toEqual([]);
    } finally {
      h.stdin.destroy();
      h.stderr.destroy();
    }
  });
});
