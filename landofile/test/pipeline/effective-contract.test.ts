import { expect, test } from "bun:test";
import { reset } from "@lando/sdk/landofile";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { loadAuthoredDocuments } from "../../src/root-compile.ts";

const root = import.meta.dir;
const file = `${root}/.lando.yml`;
const local = `${root}/.lando.local.yml`;
const load = (lower: unknown, higher: unknown) =>
  loadAuthoredDocuments(
    [
      { file, value: { name: "effective", services: { web: lower } } },
      { file: local, value: { services: { web: higher } } },
    ],
    { appRoot: root, file },
  );

test.each([
  { value: { services: "{{ { web: { container_name: 'blocked' } } }}" }, tag: "ComposeKeyRejectedError" },
  { value: { tooling: "{{ { task: { cmd: 'echo ok', deps: ['other'] } } }}" }, tag: "NotImplementedError" },
])("attributes generated policy failure $tag to the expression source", async ({ value, tag }) => {
  const error = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        { file, value: { name: "policy-origin" } },
        { file: local, value },
      ],
      { appRoot: root, file },
    ).pipe(Effect.flip),
  );
  expect(error._tag).toBe(tag);
  expect(error.message).toContain(local);
  if (error._tag === "ComposeKeyRejectedError") expect(error.source).toBe(local);
});

test.each([
  [
    { logs: [{ path: "/var/log/app.log", stream: "stdout" }] },
    { logs: [{ path: "/var/log/app.log" }] },
    { logs: [{ stream: "stdout" }] },
  ],
  [
    { ports: [{ name: "web", target: 80, protocol: "udp" }] },
    { ports: [{ name: "web", target: 81 }] },
    { ports: [{ name: "web", target: 81, protocol: "udp" }] },
  ],
  [
    { build: { context: "./site" } },
    { build: { args: { MODE: "local" } } },
    { build: { context: "./site", args: { MODE: "local" } } },
  ],
  [
    { ulimits: { nofile: { soft: 30, hard: 50 } } },
    { ulimits: { nofile: 100 } },
    { ulimits: { nofile: { soft: 100, hard: 100 } } },
  ],
  [
    { ulimits: { nofile: 100 } },
    { ulimits: { nofile: { soft: 30, hard: 50 } } },
    { ulimits: { nofile: { soft: 30, hard: 50 } } },
  ],
])(
  "applies defaults and field transforms only after authored composition (%#)",
  async (lower, higher, expected) => {
    const result = await Effect.runPromise(load(lower, higher));
    expect(result.document.services?.[ServiceName.make("web")]).toMatchObject(expected);
    const encoded = Schema.encodeSync(LandofileShape)(result.document);
    expect(
      Schema.decodeUnknownSync(LandofileShape)(encoded, { onExcessProperty: "error", errors: "all" }),
    ).toEqual(result.document);
  },
);

test.each([
  [{ workingDirectory: "/lower" }, { working_dir: "/alias" }, { workingDirectory: "/alias" }],
  [
    { workingDirectory: "/lower" },
    { working_dir: "/alias", workingDirectory: "/canonical" },
    { workingDirectory: "/canonical" },
  ],
  [{ envFile: ["lower.env"] }, { env_file: ["higher.env"] }, { envFile: ["higher.env"] }],
  [
    { dependsOn: ["db"] },
    { depends_on: ["cache"] },
    { dependsOn: [{ service: "db" }, { service: "cache" }] },
  ],
])("canonicalizes only service aliases before merging (%#)", async (lower, higher, expected) => {
  const result = await Effect.runPromise(load(lower, higher));
  expect(result.document.services?.[ServiceName.make("web")]).toMatchObject(expected);
});

test.each([
  [{ build: { dockerfile_inline: "FROM scratch" } }, { build: { dockerfileInline: "FROM busybox" } }],
  [{ security: { ca: ["root.pem"] } }, { security: { cas: ["other.pem"] } }],
  [{ networks: ["default"] }, { networks: null }],
])("does not repair conflicting spellings or null by decoding layers first (%#)", async (lower, higher) => {
  const error = await Effect.runPromise(load(lower, higher).pipe(Effect.flip));
  expect(error._tag).toBe("LandofileValidationError");
});

test("required-value deletion retains the resetting source tombstone", async () => {
  const error = await Effect.runPromise(
    load({ appMount: { target: "/site" } }, { appMount: { target: reset() } }).pipe(Effect.flip),
  );
  expect(error).toMatchObject({
    _tag: "LandofileValidationError",
    file: local,
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: ["services", "web", "appMount", "target"],
        source: { file: local, layer: "local", path: ["services", "web", "appMount", "target"] },
      }),
    ]),
  });
});

test("keyed list issue locations retain the authored index after relocation", async () => {
  const error = await Effect.runPromise(
    load(
      { logs: [{ path: "/var/log/lower.log" }] },
      { logs: [{ path: "/var/log/local.log", stream: "wrong" }] },
    ).pipe(Effect.flip),
  );
  expect(error).toMatchObject({
    _tag: "LandofileValidationError",
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: ["services", "web", "logs", 1, "stream"],
        source: { file: local, layer: "local", path: ["services", "web", "logs", 0, "stream"] },
      }),
    ]),
  });
});
