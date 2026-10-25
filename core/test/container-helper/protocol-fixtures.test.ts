import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DataPlaneApiClient } from "@lando/container-runtime/data-plane";
import { scopedDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import { buildRunLandoRequest } from "@lando/engine/subsystems/host-proxy/shim";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath, HostProxyRequest } from "@lando/sdk/schema";
import { Effect, Option, Schema, Stream } from "effect";

const fixtures = resolve(import.meta.dirname, "../../container-helper/testdata");
const readFrames = async (name: string) =>
  (await Bun.file(resolve(fixtures, name)).text()).trimEnd().split("\n");

test.each([
  ["open-url-request.jsonl", { _tag: "openUrl" as const, url: "https://example.com/x?a=1&b=two" }],
  ["open-path-request.jsonl", { _tag: "openPath" as const, path: AbsolutePath.make("/app/README") }],
])("the host decoder accepts the Go client's %s", async (name, expected) => {
  const wire = await Bun.file(resolve(fixtures, name)).text();
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(HostProxyRequest))(wire)).toEqual(expected);
});

test("the host decoder accepts the Go client's canonical runLando request", async () => {
  const wire = await Bun.file(resolve(fixtures, "run-lando-request.jsonl")).text();
  const expected = buildRunLandoRequest({
    argv: ["info", "a b", ""],
    cwd: "/tmp",
    tty: false,
    env: { LANG: "C.UTF-8", TERM: "xterm-256color", SECRET_TOKEN: "not-forwarded" },
  });
  const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(HostProxyRequest))(wire);
  expect(decoded).toEqual(expected);
});

test("the log-file session encodes canonical requests and decodes Go response frames without an ELF", async () => {
  const requests = await readFrames("log-file-requests.jsonl");
  const responses = await readFrames("log-file-responses.jsonl");
  const sent: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.succeed({ status: request.method === "POST" ? 201 : 200, body: '{"Id":"helper"}' }),
    stream: (request) =>
      Stream.fromAsyncIterable(
        (async function* () {
          if (request.stdin === undefined) {
            yield encoder.encode('{"ok":true}\n');
            return;
          }
          let index = 0;
          for await (const chunk of request.stdin) {
            const line = decoder.decode(chunk);
            sent.push(line);
            const response = `${responses[index++] ?? '{"ok":true}'}\n`;
            const bytes = encoder.encode(response);
            yield bytes.slice(0, 3);
            yield bytes.slice(3);
          }
        })(),
        (cause) =>
          new ProviderInternalError({
            providerId: "fixture",
            operation: "protocol",
            message: "Fixture transport failed",
            cause,
          }),
      ),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* scopedDockerLogFileAccess({
          sourceEnv: {},
          providerId: "fixture",
          container: "service",
          api,
          resolveHelper: Effect.succeed({
            target: { os: "linux", arch: "x64" },
            digest: "0".repeat(64),
            path: AbsolutePath.make(import.meta.filename),
          }),
        });
        expect(Option.getOrThrow(yield* access.stat("protocol.log"))).toEqual({
          dev: "1",
          ino: "2",
          size: 14n,
        });
        const handle = yield* access.open("protocol.log");
        expect(yield* handle.stat).toEqual({ dev: "1", ino: "2", size: 14n });
        expect(yield* handle.read(7n, 100)).toEqual({
          bytes: encoder.encode("line-2\n"),
          nextOffset: 14n,
          eof: true,
        });
        yield* handle.close;
      }),
    ),
  );
  expect(sent.slice(0, requests.length)).toEqual(requests.map((line) => `${line}\n`));
  expect(sent).toHaveLength(requests.length + 1);
});
