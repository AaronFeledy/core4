import { expect, test } from "bun:test";
import config from "../tsconfig.json";
import { typecheck } from "./typecheck.ts";

test("checks every root reference while separating package and test compiler lifetimes", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const exitCode = await typecheck(["--force"], async (args) => {
    calls.push(args);
    return 0;
  });
  // Then
  expect(exitCode).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(["./tsconfig.test.json", "--force"]);
  expect(calls.flatMap((args) => args.filter((arg) => arg !== "--force")).sort()).toEqual(
    config.references.map(({ path }) => path).sort(),
  );
  expect(calls.every((args) => args.at(-1) === "--force")).toBe(true);
});

test("stops on package compiler failure and preserves its exit code", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const exitCode = await typecheck([], async (args) => {
    calls.push(args);
    return 2;
  });
  // Then
  expect(exitCode).toBe(2);
  expect(calls).toHaveLength(1);
});

test("preserves a failure from the aggregate test compiler", async () => {
  // Given
  let count = 0;
  // When
  const exitCode = await typecheck([], async () => (++count === 1 ? 0 : 2));
  // Then
  expect(exitCode).toBe(2);
  expect(count).toBe(2);
});
