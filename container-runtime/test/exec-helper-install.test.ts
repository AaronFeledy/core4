import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect, Stream } from "effect";
import { CONTAINER_HELPER_FILE } from "../src/container-helper.ts";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { installExecHelper } from "../src/exec-helper-install.ts";
import { archiveLogFileHelper } from "../src/log-file-archive.ts";
import { encodeUstarHeader } from "../src/tar.ts";

const ctx = { providerId: "docker", remediation: "Retry.", env: {} };
const artifact = (value = "a static helper executable") => {
  const bytes = new TextEncoder().encode(value);
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
};
const directoryFor = (digest: string) => `lando-exec-${digest}`;
const missing = () =>
  new ProviderUnavailableError({
    ...ctx,
    operation: "archive",
    message: "Missing.",
    details: { status: 404 },
  });
const tmpHeader = () => encodeUstarHeader({ name: "tmp/", mode: 0o1777, size: 0, typeflag: "5" });
const fixture = () => {
  const requests: EngineHttpRequest[] = [];
  const archives = new Map<string, Uint8Array>();
  const state = {
    tmp: tmpHeader(),
    puts: 0,
    gets: 0,
    tmpGets: 0,
    tmpTailRead: false,
    putStatus: 200,
    persist: true,
    readError: undefined as ProviderUnavailableError | undefined,
  };
  const api: EngineHttpApi = {
    stream: (input) =>
      Stream.suspend(() => {
        requests.push(input);
        const query = new URL(`http://engine${input.path}`);
        if (query.searchParams.get("path") === "/tmp") {
          state.tmpGets++;
          return Stream.make(state.tmp.subarray(0, 97), state.tmp.subarray(97)).pipe(
            Stream.concat(
              Stream.suspend(() => {
                state.tmpTailRead = true;
                return Stream.fail(
                  new ProviderUnavailableError({
                    ...ctx,
                    operation: "archive",
                    message: "The recursive /tmp body must not be consumed.",
                  }),
                );
              }),
            ),
          );
        }
        state.gets++;
        if (state.readError !== undefined) return Stream.fail(state.readError);
        const key = `${query.pathname}:${query.searchParams.get("path")}`;
        const archive = archives.get(key);
        return archive === undefined
          ? Stream.fail(missing())
          : Stream.make(archive.subarray(0, 77), archive.subarray(77));
      }),
    request: (input) =>
      Effect.promise(async () => {
        requests.push(input);
        state.puts++;
        expect(input.method).toBe("PUT");
        expect(input.path).toEndWith("/archive?path=/tmp&noOverwriteDirNonDir=true");
        expect(input.headers).toEqual({ "Content-Type": "application/x-tar" });
        const chunks: Uint8Array[] = [];
        if (input.stdin !== undefined) for await (const chunk of input.stdin) chunks.push(chunk);
        const archive = new Uint8Array(Buffer.concat(chunks));
        const directory = new TextDecoder()
          .decode(archive.subarray(0, 100))
          .split("\0")[0]
          ?.replace(/\/$/u, "");
        if (state.persist && state.putStatus === 200)
          archives.set(`${input.path.split("?")[0]}:/tmp/${directory}`, archive);
        return { status: state.putStatus, body: "{}" };
      }),
  };
  const seed = (bytes: Uint8Array, value = artifact(), container = "container") =>
    archives.set(`/containers/${container}/archive:/tmp/${directoryFor(value.digest)}`, bytes);
  const install = (value = artifact(), container = "container") =>
    installExecHelper(api, ctx, container, value);
  return { api, state, archives, requests, seed, install };
};
const rejected = (effect: ReturnType<typeof installExecHelper>) => Effect.runPromise(Effect.flip(effect));

describe("container exec helper installation", () => {
  test("installs once per container and version, then verifies actual bytes on every reuse", async () => {
    const f = fixture();
    const a = artifact();
    expect(await Effect.runPromise(f.install())).toBe(
      `/tmp/${directoryFor(a.digest)}/${CONTAINER_HELPER_FILE}`,
    );
    expect([f.state.tmpGets, f.state.gets, f.state.puts]).toEqual([1, 2, 1]);
    await Effect.runPromise(f.install());
    expect([f.state.tmpGets, f.state.gets, f.state.puts]).toEqual([2, 3, 1]);
    await Effect.runPromise(f.install(artifact("new helper version")));
    await Effect.runPromise(f.install(a, "other-container"));
    expect([f.state.tmpGets, f.state.gets, f.state.puts]).toEqual([4, 7, 3]);
    expect(f.archives.size).toBe(3);
    expect(directoryFor(a.digest).length).toBe(75);
    expect(`${directoryFor(a.digest)}/${CONTAINER_HELPER_FILE}`.length).toBeLessThan(100);
    expect(f.requests.every((request) => request.path.includes("/archive?"))).toBe(true);
  });

  test("concurrent same-version installs share the install while each verifies the cache", async () => {
    const f = fixture();
    const values = await Effect.runPromise(
      Effect.all([f.install(), f.install(), f.install()], { concurrency: "unbounded" }),
    );
    expect(new Set(values).size).toBe(1);
    expect([f.state.tmpGets, f.state.gets, f.state.puts]).toEqual([3, 4, 1]);
  });

  test("detects corruption after a successful installation without replacing it", async () => {
    const f = fixture();
    await Effect.runPromise(f.install());
    const changed = archiveLogFileHelper(artifact().bytes, directoryFor(artifact().digest));
    changed[1024] = (changed[1024] ?? 0) ^ 1;
    f.seed(changed);
    expect((await rejected(f.install())).message).toContain("untrusted-existing-helper");
    expect([f.state.gets, f.state.puts]).toEqual([3, 1]);
  });

  test.each([
    { name: "world-writable nonsticky", mode: 0o777, uid: 0, typeflag: "5" as const },
    { name: "user-owned sticky", mode: 0o1777, uid: 1000, typeflag: "5" as const },
    { name: "symlink", mode: 0o777, uid: 0, typeflag: "2" as const },
  ])("rejects $name /tmp before touching a helper path", async ({ mode, uid, typeflag }) => {
    const f = fixture();
    f.state.tmp = encodeUstarHeader({ name: "tmp/", mode, uid, typeflag, size: 0 });
    expect((await rejected(f.install())).message).toContain("unsafe-tmp-directory");
    expect([f.state.tmpGets, f.state.gets, f.state.puts]).toEqual([1, 0, 0]);
  });

  test("accepts root-owned non-writable /tmp without draining its archive", async () => {
    const f = fixture();
    f.state.tmp = encodeUstarHeader({ name: "tmp/", mode: 0o755, typeflag: "5", size: 0 });
    await Effect.runPromise(f.install());
    expect(f.state.puts).toBe(1);
    expect(f.state.tmpTailRead).toBe(false);
  });

  test.each([
    "directory-owner",
    "directory-mode",
    "directory-link",
    "file-owner",
    "file-mode",
    "file-link",
    "wrong-path",
    "checksum",
    "payload",
    "duplicate",
    "truncated",
    "pax",
  ])("rejects untrusted existing archive: %s", async (attack) => {
    const f = fixture();
    const value = artifact();
    const directory = directoryFor(value.digest);
    let archive = archiveLogFileHelper(value.bytes, directory);
    if (attack.startsWith("directory-"))
      archive.set(
        encodeUstarHeader({
          name: `${directory}/`,
          mode: attack === "directory-mode" ? 0o777 : 0o755,
          uid: attack === "directory-owner" ? 1000 : 0,
          typeflag: attack === "directory-link" ? "2" : "5",
          size: 0,
        }),
        0,
      );
    if (attack.startsWith("file-") || attack === "wrong-path")
      archive.set(
        encodeUstarHeader({
          name:
            attack === "wrong-path" ? `../${CONTAINER_HELPER_FILE}` : `${directory}/${CONTAINER_HELPER_FILE}`,
          mode: attack === "file-mode" ? 0o777 : 0o755,
          uid: attack === "file-owner" ? 1000 : 0,
          typeflag: attack === "file-link" ? "2" : "0",
          size: value.bytes.length,
        }),
        512,
      );
    if (attack === "checksum") archive[1] = 1;
    if (attack === "payload") archive[1024] = (archive[1024] ?? 0) ^ 1;
    if (attack === "duplicate") archive.set(archive.subarray(0, 512), archive.length - 1024);
    if (attack === "truncated") archive = archive.subarray(0, archive.length - 512);
    if (attack === "pax") archive[156] = 120;
    f.seed(archive);
    expect((await rejected(f.install())).message).toContain("untrusted-existing-helper");
    expect([f.state.gets, f.state.puts]).toEqual([1, 0]);
  });

  test("bounds untrusted archive bytes before collecting them", async () => {
    const f = fixture();
    f.seed(new Uint8Array(artifact().bytes.length + 32 * 1024 + 1));
    expect((await rejected(f.install())).message).toContain("archive-limit");
    expect(f.state.puts).toBe(0);
  });

  test("preserves provider failures rather than treating them as a cache miss", async () => {
    const f = fixture();
    const error = new ProviderUnavailableError({
      ...ctx,
      operation: "archive",
      message: "Unavailable.",
      details: { status: 503 },
    });
    f.state.readError = error;
    expect(await rejected(f.install())).toBe(error);
    expect([f.state.gets, f.state.puts]).toEqual([1, 0]);
  });

  test("rejects failed uploads and verifies successful uploads before returning", async () => {
    const failed = fixture();
    failed.state.putStatus = 500;
    expect((await rejected(failed.install()))._tag).toBe("ProviderUnavailableError");
    expect([failed.state.gets, failed.state.puts]).toEqual([1, 1]);
    const absent = fixture();
    absent.state.persist = false;
    expect((await rejected(absent.install())).message).toContain("installed-helper-missing");
    expect([absent.state.gets, absent.state.puts]).toEqual([2, 1]);
  });

  test("rejects invalid local digest and missing API without provider writes", async () => {
    const f = fixture();
    expect((await rejected(f.install({ ...artifact(), digest: "0".repeat(64) }))).message).toContain(
      "artifact-digest",
    );
    expect(f.requests).toHaveLength(0);
    expect((await rejected(installExecHelper({}, ctx, "container", artifact())))._tag).toBe(
      "ProviderUnavailableError",
    );
  });
});
