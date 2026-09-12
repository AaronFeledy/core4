import { describe, expect, test } from "bun:test";
import { Either, ParseResult, Schema } from "effect";

import { BuildBlock, ServiceConfig } from "../../src/schema/landofile.ts";

const decodeOptions = [{}, { onExcessProperty: "error" }] as const;

const expectAccepted = (input: unknown, expected: typeof BuildBlock.Type): void => {
  for (const options of decodeOptions) {
    expect(Schema.decodeUnknownSync(BuildBlock)(input, options)).toEqual(expected);
    expect(Schema.decodeUnknownSync(ServiceConfig)({ build: input }, options).build).toEqual(expected);
  }
};

const expectRejected = (input: unknown): ReadonlyArray<string> => {
  const messages: string[] = [];
  for (const options of decodeOptions) {
    const result = Schema.decodeUnknownEither(BuildBlock)(input, options);
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) continue;
    messages.push(
      ParseResult.ArrayFormatter.formatErrorSync(result.left)
        .map(({ message }) => message)
        .join("\n"),
    );
  }
  return messages;
};

describe("build step objects", () => {
  test("accepts a single object step with an explicit user", () => {
    // Given
    const input = { artifact: { run: "apt-get update -y", user: "root" } };

    // When / Then
    expectAccepted(input, { artifact: { run: "apt-get update -y", user: "root" } });
  });

  test("accepts a mixed ordered array of string and object steps", () => {
    // Given
    const input = {
      app: ["npm ci", { run: "npm run build" }, { run: "chown -R node /app", user: "1000:1000" }],
    };

    // When / Then
    expectAccepted(input, {
      app: ["npm ci", { run: "npm run build" }, { run: "chown -R node /app", user: "1000:1000" }],
    });
  });

  test("preserves the plain string and string-array forms unchanged", () => {
    // Given / When / Then
    expectAccepted({ artifact: "echo one" }, { artifact: "echo one" });
    expectAccepted({ app: ["echo one", "echo two"] }, { app: ["echo one", "echo two"] });
  });

  test.each([
    ["root", "root"],
    ["a bare name", "node"],
    ["a numeric uid", "1000"],
    ["a uid:gid pair", "1000:1000"],
    ["a user:group pair", "app:staff"],
    ["dots, dashes, and underscores", "build_user.v2-a"],
  ])("accepts %s as a step user", (_label, user) => {
    // Given / When / Then
    expectAccepted({ artifact: { run: "echo hi", user } }, { artifact: { run: "echo hi", user } });
  });

  test("rejects an object step with no run command", () => {
    // Given / When / Then
    expect(expectRejected({ artifact: { user: "root" } }).length).toBeGreaterThan(0);
  });

  test("rejects an empty run command", () => {
    // Given / When / Then
    expect(expectRejected({ artifact: { run: "" } }).length).toBeGreaterThan(0);
  });

  test.each([
    ["an empty user", ""],
    ["a newline injection", "root\nUSER attacker"],
    ["a trailing backslash continuation", "root\\"],
    ["embedded whitespace", "root wheel"],
    ["a leading hyphen", "-root"],
    ["a shell metacharacter", "root;id"],
    ["an empty group", "root:"],
    ["a path separator", "/root"],
  ])("rejects %s as a step user", (_label, user) => {
    // Given / When / Then
    expect(expectRejected({ artifact: { run: "echo hi", user } }).length).toBeGreaterThan(0);
  });

  test("rejects an unknown key on an object step", () => {
    // Given — every Landofile decode path in core decodes with onExcessProperty: "error"
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { build: { app: { run: "echo hi", cmd: "echo bye" } } },
      { onExcessProperty: "error" },
    );

    // When / Then
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) return;
    expect(
      ParseResult.ArrayFormatter.formatErrorSync(result.left)
        .map(({ message }) => message)
        .join("\n"),
    ).toContain("cmd");
  });

  test("keeps object steps inside the Lando key family", () => {
    // Given / When / Then
    const messages = expectRejected({ context: ".", artifact: { run: "echo hi" } });
    for (const message of messages) expect(message).toContain("artifact");
  });
});
