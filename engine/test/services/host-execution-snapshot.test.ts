import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import {
  captureHostExecutionContext,
  prepareHostExecutionContext,
} from "../../src/services/host-execution-context.ts";
import { prepareProcessSpawn } from "../../src/services/process-spawn-context.ts";

test.each([
  { overrides: { pWd: "first", PWD: "last" }, parent: {}, key: "pWd", expected: "last" },
  { overrides: { pWd: "first", PWD: "" }, parent: { Pwd: "stale" }, key: "Pwd", expected: "" },
  { overrides: { PWD: "first", pWd: "last" }, parent: { pWD: "stale" }, key: "pWD", expected: "last" },
  { overrides: { PWD: "first", pWd: "" }, parent: {}, key: "PWD", expected: "" },
])("Windows PWD uses the last caller casing override: %j", async ({ overrides, parent, key, expected }) => {
  // Given
  const captured = captureHostExecutionContext(
    { env: overrides },
    { cwd: "C:\\app", env: parent, platform: "win32" },
  );
  // When
  const result = await prepareHostExecutionContext(captured, async () => "C:\\app");
  // Then
  expect(result.env).toEqual({ [key]: expected });
});

test.each([undefined, "explicit", ""])(
  "snapshots parent/caller values and defaults PWD with override %j",
  async (pwd) => {
    // Given
    const parent = { PWD: "/stale", TOKEN: "before", PATH: "before-path" };
    const env: Record<string, string> = { CALLER: "before", ...(pwd === undefined ? {} : { PWD: pwd }) };
    const captured = captureHostExecutionContext(
      { env },
      { cwd: "/captured", env: parent, platform: "linux" },
    );
    const lookup = Promise.withResolvers<string>();
    const paths: string[] = [];
    // When
    const running = prepareHostExecutionContext(captured, (path) => {
      paths.push(path);
      return lookup.promise;
    });
    parent.TOKEN = "after";
    parent.PATH = "after-path";
    env.CALLER = "after";
    if (pwd !== undefined) env.PWD = "after";
    lookup.resolve("/physical");
    const result = await running;
    // Then
    expect(paths).toEqual(["/captured/"]);
    expect(result).toEqual({
      cwd: "/physical",
      env: { PWD: pwd ?? "/physical", TOKEN: "before", PATH: "before-path", CALLER: "before" },
    });
  },
);

test.each([undefined, "explicit", ""])(
  "merges all Windows environment keys case-insensitively with Pwd %j",
  async (pwd) => {
    // Given
    const captured = captureHostExecutionContext(
      {
        cwd: "C:child",
        env: { Path: "caller-path", token: "caller-token", ...(pwd === undefined ? {} : { Pwd: pwd }) },
      },
      {
        cwd: "C:\\captured",
        env: { PATH: "parent-path", TOKEN: "parent-token", PWD: "stale" },
        platform: "win32",
      },
    );
    const paths: string[] = [];
    // When
    const result = await prepareHostExecutionContext(captured, async (path) => {
      paths.push(path);
      return "C:\\physical";
    });
    // Then
    expect(paths).toEqual(["C:\\captured\\child\\"]);
    expect(result.env).toEqual({ PATH: "caller-path", TOKEN: "caller-token", PWD: pwd ?? "C:\\physical" });
  },
);

test.each(["\\child", "D:child", "\\\\server\\share\\child"])(
  "qualifies Windows native cwd %j without POSIX walking",
  async (cwd) => {
    // Given
    const captured = captureHostExecutionContext(
      { cwd },
      {
        cwd: "C:\\captured",
        env: { "=D:": "D:\\remembered" },
        platform: "win32",
      },
    );
    const paths: string[] = [];
    // When
    await prepareHostExecutionContext(captured, async (path) => {
      paths.push(path);
      return path;
    });
    // Then
    expect(paths).toEqual([
      `${cwd === "\\child" ? "C:\\child" : cwd === "D:child" ? "D:\\remembered\\child" : cwd}\\`,
    ]);
  },
);

test("aborting during directory lookup prevents acquiring a spawn context", async () => {
  // Given
  const controller = new AbortController();
  const lookup = Promise.withResolvers<string>();
  const captured = captureHostExecutionContext({});
  let acquired = false;
  // When
  const result = prepareProcessSpawn(
    captured,
    { signal: controller.signal, bunCommandEnv: true },
    () => lookup.promise,
  ).then(async (context) => {
    acquired = true;
    await context[Symbol.asyncDispose]();
  });
  controller.abort();
  lookup.resolve(await realpath(process.cwd()));
  // Then
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(acquired).toBe(false);
});
