import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { renderGlobalDist } from "../../src/global-app/dist-content.ts";

test("encodes global dist endpoints and filters as kind and reloads them through the shared loader", async () => {
  // Given decoded service configs produced from authored wire.
  const services = {
    mail: Schema.decodeUnknownSync(ServiceConfig)({
      type: "compose",
      image: "axllent/mailpit:latest",
      endpoints: ["http:8025", { kind: "internal", protocol: "tcp", port: 1025, name: "smtp" }],
    }),
    edge: Schema.decodeUnknownSync(ServiceConfig)({
      type: "nginx",
      routes: [
        {
          hostname: "mail.lndo.site",
          filters: [
            { kind: "stripPrefix", prefix: "/api" },
            { kind: "addPrefix", prefix: "/v1" },
          ],
        },
      ],
    }),
  };

  // When the managed dist is rendered and loaded with the ordinary Landofile path.
  const yaml = renderGlobalDist(services);
  expect(yaml).toContain("kind: internal");
  expect(yaml).toContain("kind: stripPrefix");
  expect(yaml).not.toContain("_tag:");
  expect(yaml).not.toMatch(/type:\s*stripPrefix/);

  const root = await mkdtemp(join(tmpdir(), "lando-global-dist-"));
  try {
    const file = join(root, ".lando.dist.yml");
    const body = yaml.split(/\r?\n/).slice(3).join("\n");
    const loaded = await Effect.runPromise(
      loadAuthoredDocuments([{ file, value: Bun.YAML.parse(body) }], { appRoot: root, file }),
    );

    // Then decoded endpoints and filters round-trip without a second codec.
    expect(loaded.document.services?.[ServiceName.make("mail")]?.endpoints).toEqual([
      { kind: "internal", protocol: "http", port: 8025 },
      { kind: "internal", protocol: "tcp", port: 1025, name: "smtp" },
    ]);
    expect(loaded.document.services?.[ServiceName.make("edge")]?.routes?.[0]).toMatchObject({
      filters: [
        { kind: "stripPrefix", prefix: "/api" },
        { kind: "addPrefix", prefix: "/v1" },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
