import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { getLandofileValueSource } from "../src/validation.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-compose-defaults-"));
  await mkdir(join(root, "sibling"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const load = () =>
  Effect.runPromise(
    loadLandofileLayers(root, join(root, ".lando.yml"), {
      ports: makeTestLandofilePorts(root),
      stateStore: makeTestLandofileStateStore(),
      templates: { modules: [] },
    }),
  );
const fragment = "sibling/compose.yaml";
const mail = ServiceName.make("mail");
const main = ServiceName.make("main");

test.each([`include: [${fragment}]`, `includes:\n  - source: ./${fragment}\n    kind: compose`])(
  "defaults plain Compose services with %s and retains fragment provenance",
  async (include) => {
    // Given
    await writeFile(join(root, ".lando.yml"), `name: defaults\n${include}\n`);
    await writeFile(
      join(root, fragment),
      "services:\n  mail:\n    image: axllent/mailpit:v1.27\n    env_file: [.env.mail]\n    volumes: ['./data:/data']\n",
    );
    // When
    const { document } = await load();
    // Then
    expect(document.services?.[mail]).toMatchObject({
      type: "compose",
      home: false,
      appMount: false,
      image: "axllent/mailpit:v1.27",
      envFile: ["./sibling/.env.mail"],
      volumes: [{ type: "bind", source: "./sibling/data", target: "/data" }],
    });
    for (const key of ["type", "home", "appMount"])
      expect(getLandofileValueSource(document, ["services", "mail", key])).toEqual({
        file: join(root, fragment),
        layer: "canonical",
        path: ["services", "mail"],
      });
    expect(getLandofileValueSource(document, ["services", "mail", "envFile", 0])).toEqual({
      file: join(root, fragment),
      layer: "canonical",
      path: ["services", "mail", "env_file", 0],
    });
  },
);

test("preserves explicit fragment service values", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), `name: defaults\ninclude: [${fragment}]\n`);
  await writeFile(
    join(root, fragment),
    "services:\n  mail:\n    type: mailpit\n    home:\n      path: /home/mail\n    appMount: /site\n",
  );
  // When
  const { document } = await load();
  // Then
  expect(document.services?.[mail]).toMatchObject({
    type: "mailpit",
    home: { path: "/home/mail" },
    appMount: { target: "/site" },
  });
  expect(getLandofileValueSource(document, ["services", "mail", "type"])?.path).toEqual([
    "services",
    "mail",
    "type",
  ]);
});

test.each([".lando.yml", ".lando.local.yml"])("lets %s override Compose defaults", async (file) => {
  // Given
  const include = `name: defaults\ninclude: [${fragment}]\n`;
  const override =
    "services:\n  mail:\n    type: mailpit\n    home:\n      path: /home/mail\n    appMount: /site\n";
  await writeFile(join(root, ".lando.yml"), include + (file === ".lando.yml" ? override : ""));
  if (file !== ".lando.yml") await writeFile(join(root, file), override);
  await writeFile(join(root, fragment), "services:\n  mail:\n    image: axllent/mailpit:v1.27\n");
  // When
  const { document } = await load();
  // Then
  expect(document.services?.[mail]).toMatchObject({
    type: "mailpit",
    home: { path: "/home/mail" },
    appMount: { target: "/site" },
  });
  for (const key of ["type", "home", "appMount"])
    expect(getLandofileValueSource(document, ["services", "mail", key])?.file).toBe(join(root, file));
});

test.each([`includes: [${fragment}]`, `includes:\n  - source: ${fragment}\n    kind: landofile`])(
  "leaves main and non-Compose fragment services unchanged with %s",
  async (include) => {
    // Given
    await writeFile(
      join(root, ".lando.yml"),
      `name: defaults\n${include}\nservices:\n  main:\n    image: nginx\n`,
    );
    await writeFile(
      join(root, fragment),
      "services:\n  mail:\n    image: axllent/mailpit:v1.27\n    env_file: [.env.mail]\n    volumes: ['./data:/data']\n",
    );
    // When
    const { document } = await load();
    // Then
    for (const service of [document.services?.[main], document.services?.[mail]]) {
      expect(service?.type).toBeUndefined();
      expect(service?.home).toBeUndefined();
      expect(service?.appMount).toBeUndefined();
    }
    expect(document.services?.[mail]).toMatchObject({
      envFile: [".env.mail"],
      volumes: [{ type: "bind", source: "./data", target: "/data" }],
    });
  },
);

test("does not default a nested Landofile fragment inside a Compose fragment", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), `name: defaults\ninclude: [${fragment}]\n`);
  await writeFile(join(root, fragment), "includes: [./lando.yml]\n");
  await writeFile(join(root, "sibling/lando.yml"), "services:\n  mail:\n    image: mailpit\n");
  // When
  const { document } = await load();
  // Then
  expect(document.services?.[mail]?.type).toBeUndefined();
  expect(document.services?.[mail]?.home).toBeUndefined();
  expect(document.services?.[mail]?.appMount).toBeUndefined();
});

test.each(["services:\n  mail: !override", "services: !override\n  mail:"])(
  "defaults Compose services within override mappings: %s",
  async (services) => {
    // Given
    await writeFile(join(root, ".lando.yml"), `name: defaults\ninclude: [${fragment}]\n`);
    await writeFile(
      join(root, fragment),
      `${services}\n    image: mailpit\n    env_file: !override [.env.mail]\n    volumes: !override ['./data:/data']\n`,
    );
    // When
    const { document } = await load();
    // Then
    expect(document.services?.[mail]).toMatchObject({
      type: "compose",
      home: false,
      appMount: false,
      envFile: ["./sibling/.env.mail"],
      volumes: [{ type: "bind", source: "./sibling/data", target: "/data" }],
    });
  },
);

test("does not resurrect a reset Compose service", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), `name: defaults\ninclude: [${fragment}]\n`);
  await writeFile(join(root, fragment), "services:\n  mail: !reset\n");
  // When
  const { document } = await load();
  // Then
  expect(document.services?.[mail]).toBeUndefined();
});

test("rebases nested Compose includes exactly once from each declaring directory", async () => {
  // Given
  await mkdir(join(root, "a/b"), { recursive: true });
  await writeFile(join(root, ".lando.yml"), "name: nested\ninclude: [a/compose.yaml]\n");
  await writeFile(join(root, "a/compose.yaml"), "include: [b/compose.yaml]\n");
  await writeFile(
    join(root, "a/b/compose.yaml"),
    "services:\n  mail:\n    image: mailpit\n    env_file: ../shared/.env\n    build:\n      context: image\n      dockerfile: ../Dockerfile\nconfigs:\n  config:\n    file: ./config\nsecrets:\n  secret:\n    file: ./secret\n",
  );
  // When
  const { document } = await load();
  // Then
  expect(document.services?.[mail]).toMatchObject({
    envFile: ["./a/shared/.env"],
    build: { context: "./a/b/image", dockerfile: "../Dockerfile" },
  });
  expect(document.configs).toMatchObject({ config: { file: "./a/b/config" } });
  expect(document.secrets).toMatchObject({ secret: { file: "./a/b/secret" } });
});

test("still rejects unsupported env_file objects rather than bypassing Compose dispositions", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), `name: defaults\ninclude: [${fragment}]\n`);
  await writeFile(
    join(root, fragment),
    "services:\n  mail:\n    image: mailpit\n    env_file:\n      - path: .env.mail\n        required: false\n",
  );
  // When / Then
  await expect(load()).rejects.toMatchObject({ _tag: "ComposeKeyRejectedError" });
});
