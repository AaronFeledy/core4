import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { selectEvent } from "../src/events/index.ts";

const source = { file: ".github/workflows/test.yml", line: 3, column: 1 };
const run = (triggers: Parameters<typeof selectEvent>[0], request: Parameters<typeof selectEvent>[1]) =>
  Effect.runPromise(selectEvent(triggers, request, source));
const push = {
  mode: "simulation" as const,
  name: "push" as const,
  payload: {},
  ref: "refs/heads/main",
  changedFiles: ["src/main.ts"],
};

test("push applies ordered exclusions, reinclusion and branch AND path", async () => {
  const trigger = {
    name: "push" as const,
    branches: ["**", "!release/**", "release/ok"],
    paths: ["src/**", "!src/private/**"],
  };
  expect((await run([trigger], push)).kind).toBe("selected");
  expect((await run([trigger], { ...push, ref: "refs/heads/release/no" })).kind).toBe("not-selected");
  expect((await run([trigger], { ...push, ref: "refs/heads/release/ok" })).kind).toBe("selected");
  expect((await run([trigger], { ...push, changedFiles: ["src/private/key"] })).kind).toBe("not-selected");
});
test("path changes distinguish empty from absent; tags skip paths", async () => {
  const triggers = [{ name: "push" as const, paths: ["**.ts"] }];
  expect((await run(triggers, { ...push, changedFiles: [] })).kind).toBe("not-selected");
  const { changedFiles: _, ...absent } = push;
  expect((await run(triggers, absent)).kind).toBe("deferred");
  expect((await run(triggers, { ...absent, ref: "refs/tags/v1" })).kind).toBe("selected");
  expect((await run([{ name: "push", branches: ["**"] }], { ...push, ref: "refs/tags/v1" })).kind).toBe(
    "not-selected",
  );
});
test("PR targets base branch and default activity types", async () => {
  const req = {
    mode: "supplied" as const,
    name: "pull_request" as const,
    payload: {},
    baseRef: "main",
    activity: "opened",
  };
  expect((await run([{ name: "pull_request", branches: ["main"] }], req)).kind).toBe("selected");
  expect((await run([{ name: "pull_request" }], { ...req, activity: "closed" })).kind).toBe("not-selected");
  expect(
    (await run([{ name: "pull_request", types: ["closed"] }], { ...req, activity: "closed" })).kind,
  ).toBe("selected");
});
test("dispatch and call validate types, unknowns, defaults, choices and secrets", async () => {
  const triggers = [
    {
      name: "workflow_dispatch" as const,
      inputs: {
        flag: { type: "boolean" as const, required: true },
        choice: { type: "choice" as const, options: ["a", "b"], default: "a" },
      },
    },
  ];
  const req = {
    mode: "simulation" as const,
    name: "workflow_dispatch" as const,
    payload: {},
    inputs: { flag: true },
  };
  expect(await run(triggers, req)).toMatchObject({
    kind: "selected",
    mode: "simulation",
    inputs: { flag: true, choice: "a" },
  });
  for (const inputs of [{ flag: "true" }, { flag: true, unknown: "x" }, { flag: true, choice: "c" }, {}]) {
    const result = await Effect.runPromise(Effect.result(selectEvent(triggers, { ...req, inputs }, source)));
    expect(Result.isFailure(result)).toBe(true);
  }
  expect(
    await run([{ name: "workflow_call", inputs: { n: { type: "number" } } }], {
      ...req,
      name: "workflow_call",
      inputs: {},
    }),
  ).toMatchObject({ inputs: { n: 0 } });
  const secret = await Effect.runPromise(
    Effect.result(
      selectEvent(
        [{ name: "workflow_call", secrets: { key: { required: true } } }],
        { ...req, name: "workflow_call", inputs: {} },
        source,
      ),
    ),
  );
  expect(Result.isFailure(secret)).toBe(true);
});
test("schedule selects explicit cron or bounded explicit simulation clock", async () => {
  const triggers = [{ name: "schedule" as const, schedules: ["0 12 * * 1", "30 8 * * *"] }];
  expect(
    (await run(triggers, { mode: "supplied", name: "schedule", payload: {}, schedule: "0 12 * * 1" })).kind,
  ).toBe("selected");
  expect(
    (
      await run(triggers, {
        mode: "simulation",
        name: "schedule",
        payload: {},
        clock: { minute: 0, hour: 12, dayOfMonth: 2, month: 11, dayOfWeek: 1 },
      })
    ).kind,
  ).toBe("selected");
  expect((await run(triggers, { mode: "simulation", name: "schedule", payload: {} })).kind).toBe("deferred");
});
test("unsupported patterns and unsafe inputs fail with fixed located errors", async () => {
  for (const pattern of ["[ab]", "a+", "../PRIVATE", "a\\b"]) {
    const result = await Effect.runPromise(
      Effect.result(selectEvent([{ name: "push", paths: [pattern] }], push, source)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.source).toEqual(source);
      expect(result.failure).toMatchObject({ remediation: expect.any(String) });
      expect(JSON.stringify(result.failure)).not.toContain("PRIVATE");
    }
  }
});

test("null input is invalid even with a default, and cron restricted days use OR", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      selectEvent(
        [{ name: "workflow_dispatch", inputs: { flag: { type: "boolean", default: true } } }],
        { mode: "simulation", name: "workflow_dispatch", payload: {}, inputs: { flag: null } },
        source,
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(
    (
      await run([{ name: "schedule", schedules: ["0 12 1 * 1"] }], {
        mode: "simulation",
        name: "schedule",
        payload: {},
        clock: { minute: 0, hour: 12, dayOfMonth: 2, month: 11, dayOfWeek: 1 },
      })
    ).kind,
  ).toBe("selected");
});
test("event admission bounds strings and rejects getters without invoking them", async () => {
  let invoked = false;
  const inputs = Object.defineProperty({}, "flag", {
    enumerable: true,
    get() {
      invoked = true;
      return true;
    },
  });
  const result = await Effect.runPromise(
    Effect.result(
      selectEvent(
        [{ name: "workflow_dispatch", inputs: { flag: { type: "boolean" } } }],
        { mode: "simulation", name: "workflow_dispatch", payload: {}, inputs },
        source,
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(invoked).toBe(false);
  const long = await Effect.runPromise(
    Effect.result(
      selectEvent(
        [{ name: "workflow_dispatch", inputs: { flag: { type: "string", default: "x".repeat(300000) } } }],
        { mode: "simulation", name: "workflow_dispatch", payload: {} },
        source,
      ),
    ),
  );
  expect(Result.isFailure(long)).toBe(true);
});

// Official workflow syntax golden examples, deliberately restricted to our admitted
// literal/*/** subset. https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
const eventGoldens: readonly [string, string, boolean][] = [
  ["feature/*", "feature/my-branch", true],
  ["feature/*", "feature/a/b", false],
  ["feature/**", "feature/a/b", true],
  ["**", "all/the/branches", true],
  ["v1.*", "v1.9.1", true],
  ["docs/*", "docs/file.txt", true],
  ["docs/*", "docs/a/file.txt", false],
  ["docs/**", "docs/a/file.txt", true],
  ["docs/**/*.md", "docs/README.md", true],
  ["docs/**/*.md", "docs/a/hello.md", true],
  ["releases/**-alpha", "releases/beta/3-alpha", true],
];
test("official event glob golden subset", async () => {
  for (const [pattern, value, selected] of eventGoldens) {
    const result = await run([{ name: "push", paths: [pattern] }], { ...push, changedFiles: [value] });
    expect(result.kind === "selected").toBe(selected);
  }
});
test("unsupported cron simulation grammar is rejected even after an earlier match", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      selectEvent(
        [{ name: "schedule", schedules: ["0 12 * * *", "*/5 * * * *"] }],
        {
          mode: "simulation",
          name: "schedule",
          payload: {},
          clock: { minute: 0, hour: 12, dayOfMonth: 2, month: 11, dayOfWeek: 1 },
        },
        source,
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
});

test("required delivery identity fields fail with source-located tagged errors", async () => {
  const requests: Parameters<typeof selectEvent>[1][] = [
    { mode: "supplied", name: "push", payload: {} },
    { mode: "supplied", name: "pull_request", payload: {}, activity: "opened" },
    { mode: "supplied", name: "pull_request", payload: {}, baseRef: "main" },
    { mode: "supplied", name: "schedule", payload: {} },
  ];
  for (const request of requests) {
    const result = await Effect.runPromise(
      Effect.result(selectEvent([{ name: request.name }], request, source)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: "ActionsEventError",
        code: "event-invalid",
        source,
        remediation: expect.any(String),
      });
  }
});
test("deferred changed files and simulation clock carry their source", async () => {
  expect(
    await run([{ name: "push", paths: ["**"] }], {
      mode: "simulation",
      name: "push",
      payload: {},
      ref: "refs/heads/main",
    }),
  ).toMatchObject({ kind: "deferred", source });
  expect(
    await run([{ name: "schedule", schedules: ["0 12 * * *"] }], {
      mode: "simulation",
      name: "schedule",
      payload: {},
    }),
  ).toMatchObject({ kind: "deferred", source });
});
