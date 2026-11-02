import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeLineFramer } from "@lando/sdk/log-follow";
import { createStandaloneRedactor, makeRedactionService } from "../src/service.ts";

describe("truncated log line redaction", () => {
  test("masks a registered secret when it straddles a real framer cut", async () => {
    const service = makeRedactionService();
    const redactor = await Effect.runPromise(service.forProfile("secrets"));
    await Effect.runPromise(service.registerValues(["private-credential"]));
    const lines = makeLineFramer(12).feed(new TextEncoder().encode("prefix private-credential\n"));

    const redacted = lines.map((line) => redactor.redactString(line.text));

    expect(redacted).toEqual(["prefix [redacted] …[truncated]"]);
  });

  test("masks secret env prefixes at multiple markers inside a joined tail", () => {
    const redactor = createStandaloneRedactor("secrets", {
      sourceEnv: { API_TOKEN: "private-credential" },
    });
    const lines = makeLineFramer(12).feed(
      new TextEncoder().encode("prefix private-credential\nprefix private-credential\nlast\n"),
    );

    const redacted = redactor.redactString(lines.map((line) => line.text).join("\n"));

    expect(redacted).toBe("prefix [redacted] …[truncated]\nprefix [redacted] …[truncated]\nlast");
  });

  test("masks even a one-character proper prefix when a line is cut", () => {
    const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: ["private-credential"] });
    const lines = makeLineFramer(8).feed(new TextEncoder().encode("prefix private-credential\n"));

    const redacted = lines.map((line) => redactor.redactString(line.text));

    expect(redacted).toEqual(["prefix [redacted] …[truncated]"]);
  });

  test("chooses the longest matching prefix across exact values", () => {
    const redactor = createStandaloneRedactor("secrets", {
      authoritativeTokens: ["vate-longer-credential", "private-credential"],
    });

    const redacted = redactor.redactString("prefix private …[truncated]");

    expect(redacted).toBe("prefix [redacted] …[truncated]");
  });

  test("preserves partial values without a marker and masks full values normally", () => {
    const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: ["private-credential"] });

    const redacted = redactor.redactString("prefix private and private-credential");

    expect(redacted).toBe("prefix private and [redacted]");
  });

  test("masks a full secret before a marker through normal exact replacement", () => {
    const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: ["private-credential"] });

    const redacted = redactor.redactString("prefix private-credential …[truncated]\nlast");

    expect(redacted).toBe("prefix [redacted] …[truncated]\nlast");
  });
});
