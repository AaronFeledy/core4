import { fileURLToPath } from "node:url";

import { LandofileShape } from "@lando/sdk/schema";
import { Result, Schema, SchemaIssue } from "effect";

import { COMPILED_DECODER_ASTS } from "../../src/cli/compiled-decoder-targets.ts";
import { install } from "../../src/cli/generated/compiled-decoders.mjs";

// Run in its own process: installation replaces the shared decoder registry.
if (process.argv[2] === "compiled") install(COMPILED_DECODER_ASTS);

const root = fileURLToPath(new URL("../../../", import.meta.url));
const options = { onExcessProperty: "error", errors: "all" } as const;

const curated: ReadonlyArray<{ readonly id: string; readonly input: unknown }> = [
  { id: "unknown-top-level", input: { name: "demo", typo: true } },
  { id: "unknown-service-key", input: { name: "demo", services: { web: { imgae: "nginx" } } } },
  { id: "wrong-name-type", input: { name: 5 } },
  { id: "port-out-of-range", input: { name: "demo", router: { httpPort: 70000 } } },
  { id: "optional-null", input: { name: "demo", router: null } },
  { id: "compose-port-out-of-range", input: { name: "demo", services: { web: { ports: [70000] } } } },
  { id: "empty-build", input: { name: "demo", services: { web: { build: {} } } } },
  {
    id: "conflicting-build-files",
    input: {
      name: "demo",
      services: { web: { build: { dockerfile: "Dockerfile", dockerfile_inline: "FROM nginx" } } },
    },
  },
  {
    id: "reserved-map-key",
    input: JSON.parse('{"name":"demo","services":{"web":{"environment":{"__proto__":"value"}}}}'),
  },
  { id: "invalid-semver-range", input: { name: "demo", lando: "not-semver" } },
  {
    id: "extension-values",
    input: { name: "demo", "x-meta": { arbitrary: [null, 3] }, services: { web: { "x-meta": true } } },
  },
  {
    id: "both-build-phases",
    input: { name: "demo", services: { web: { build: { artifact: "echo artifact", app: "echo app" } } } },
  },
  {
    id: "inline-build",
    input: { name: "demo", services: { web: { build: { dockerfile_inline: "FROM nginx" } } } },
  },
  { id: "event-steps", input: { name: "demo", events: { "pre-start": ["echo ready"] } } },
];

const paths = [
  ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.yml").scanSync({ cwd: root, dot: true }),
  ...new Bun.Glob("recipes/**/.lando.yml").scanSync({ cwd: root, dot: true }),
].sort();
const fixtures = [
  ...(await Promise.all(
    paths.map(async (id) => ({
      id,
      input: Bun.YAML.parse(await Bun.file(`${root}${id}`).text()) as unknown,
    })),
  )),
  ...curated,
];

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const results = fixtures.map(({ id, input }) => {
  const decoded = Schema.decodeUnknownResult(LandofileShape)(input, options);
  return Result.isSuccess(decoded)
    ? { id, ok: true, value: decoded.success }
    : { id, ok: false, issues: formatIssues(decoded.failure.issue).issues };
});
await Bun.write(Bun.stdout, JSON.stringify(results));
