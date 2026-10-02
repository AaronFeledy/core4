import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { UNSUPPORTED_REMEDIATION, rejectUnsupportedToolingFeatures } from "../src/tooling-unsupported.ts";

const FILE = "/workspace/.lando.yml";

const run = (parsed: unknown) =>
  Effect.runPromise(Effect.result(rejectUnsupportedToolingFeatures(FILE, parsed)));

describe("rejectUnsupportedToolingFeatures — supported authoring keys", () => {
  test("accepts task-level user with cmd", async () => {
    // Given
    const parsed = { tooling: { build: { user: "root", cmd: "x" } } };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Right");
  });

  test("accepts task-level disabled with cmd", async () => {
    // Given
    const parsed = { tooling: { build: { disabled: true, cmd: "x" } } };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Right");
  });

  test("accepts object cmds steps with cmd and supported overrides", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          cmds: [{ cmd: "x", service: "web", dir: "/app", user: "root", env: { K: "v" } }],
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Right");
  });

  test("accepts full flag metadata keys", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          flags: {
            n: {
              alias: "x",
              choices: ["a"],
              boolean: false,
              default: "a",
              required: true,
            },
          },
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Right");
  });

  test("accepts full arg metadata keys including order", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          args: {
            a: { order: 0, choices: ["a"] },
          },
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Right");
  });
});

describe("rejectUnsupportedToolingFeatures — still-rejected surfaces", () => {
  test("rejects step-object defer and names it in the message", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          cmds: [{ cmd: "x", defer: true }],
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Failure") throw new Error("expected unsupported tooling failure");
    expect(outcome.failure._tag).toBe("NotImplementedError");
    expect(outcome.failure.message).toContain("defer");
    expect(outcome.failure).toMatchObject({
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    });
  });

  test("rejects step-object task reference", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          cmds: [{ task: "other" }],
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Failure") throw new Error("expected unsupported tooling failure");
    expect(outcome.failure._tag).toBe("NotImplementedError");
    expect(outcome.failure.message).toContain("task");
    expect(outcome.failure).toMatchObject({
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    });
  });

  test("rejects unknown step-object key and names it in the message", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          cmds: [{ cmd: "x", bogus: 1 }],
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Failure") throw new Error("expected unsupported tooling failure");
    expect(outcome.failure._tag).toBe("NotImplementedError");
    expect(outcome.failure.message).toContain("bogus");
    expect(outcome.failure).toMatchObject({
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    });
  });

  test("rejects flag type key and names it in the message", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          flags: {
            n: { type: "option" },
          },
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Failure") throw new Error("expected unsupported tooling failure");
    expect(outcome.failure._tag).toBe("NotImplementedError");
    expect(outcome.failure.message).toContain("type");
    expect(outcome.failure).toMatchObject({
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    });
  });

  test("still rejects task-level deps as unsupported", async () => {
    // Given
    const parsed = {
      tooling: {
        build: {
          deps: ["x"],
        },
      },
    };

    // When
    const outcome = await run(parsed);

    // Then
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Failure") throw new Error("expected unsupported tooling failure");
    expect(outcome.failure._tag).toBe("NotImplementedError");
    expect(outcome.failure.message).toContain("deps");
    expect(outcome.failure).toMatchObject({
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    });
  });
});
