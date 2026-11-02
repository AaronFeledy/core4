import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { override, reset } from "@lando/sdk/landofile";
import { composeIncludeDefaults } from "../src/include-compose-defaults.ts";

const roots = { appRoot: resolve("app"), sourceRoot: resolve("app/mailstack") };

test.each([
  ["volumes", ["./data:/data:ro", "../shared:/shared"], ["./mailstack/data:/data:ro", "./shared:/shared"]],
  [
    "volumes",
    [{ type: "bind", source: "data", target: "/data" }],
    [{ type: "bind", source: "./mailstack/data", target: "/data" }],
  ],
  ["volumes", [{ source: "./data", target: "/data" }], [{ source: "./mailstack/data", target: "/data" }]],
  ["env_file", ".env.mail", "./mailstack/.env.mail"],
  ["env_file", [".env.mail", "../shared/.env"], ["./mailstack/.env.mail", "./shared/.env"]],
  ["envFile", [".env.mail"], ["./mailstack/.env.mail"]],
  [
    "env_file",
    [{ path: ".env.mail" }, { path: "extra.env", required: false }],
    [{ path: "./mailstack/.env.mail" }, { path: "./mailstack/extra.env", required: false }],
  ],
  ["build", "./image", "./mailstack/image"],
  [
    "build",
    { context: "image", dockerfile: "../Dockerfile" },
    { context: "./mailstack/image", dockerfile: "../Dockerfile" },
  ],
  ["build", { dockerfile: "Dockerfile" }, { context: "./mailstack", dockerfile: "Dockerfile" }],
  ["devices", ["./device:/dev/test:rwm"], ["./mailstack/device:/dev/test:rwm"]],
  [
    "devices",
    [{ source: "device", target: "/dev/test", permissions: "rw" }],
    [{ source: "./mailstack/device", target: "/dev/test", permissions: "rw" }],
  ],
] as const)("rebases service %s host paths (%j)", (field, input, expected) => {
  // Given
  const document = { services: { mail: { [field]: input } } };
  // When
  const result = composeIncludeDefaults(document, roots);
  // Then
  expect(result).toMatchObject({ services: { mail: { [field]: expected } } });
});

test.each(["configs", "secrets"])(
  "rebases %s definition files without changing names or metadata",
  (field) => {
    // Given
    const document = {
      [field]: {
        local: { file: "./config", "x-note": "./keep" },
        remote: { external: true, name: "shared" },
      },
    };
    // When
    const result = composeIncludeDefaults(document, roots);
    // Then
    expect(result[field]).toEqual({
      local: { file: "./mailstack/config", "x-note": "./keep" },
      remote: { external: true, name: "shared" },
    });
  },
);

test("rebases top-level env files", () => {
  // Given
  const document = { env_file: [".env.shared"] };
  // When
  const result = composeIncludeDefaults(document, roots);
  // Then
  expect(result.env_file).toEqual(["./mailstack/.env.shared"]);
});

test.each(["/var/data", "~/data", "C:\\data", "\\\\server\\share"])(
  "preserves absolute and home path %s",
  (path) => {
    // Given
    const document = {
      services: {
        mail: {
          volumes: [`${path}:/data`, { type: "bind", source: path, target: "/other" }],
          env_file: [path],
          build: { context: path },
          devices: [{ source: path }],
        },
      },
      configs: { config: { file: path } },
      secrets: { secret: { file: path } },
    };
    // When
    const result = composeIncludeDefaults(document, roots);
    // Then
    expect(result).toMatchObject(document);
  },
);

test("preserves volume names, container paths, grants, rejected fields, and extension data", () => {
  // Given
  const document = {
    services: {
      mail: {
        volumes: [
          "dbdata:/db",
          "/anonymous",
          { type: "volume", source: "dbdata", target: "/db", volume: { subpath: "data" } },
        ],
        configs: [{ source: "config", target: "/config" }],
        secrets: ["secret"],
        working_dir: "/work",
        command: "./run",
        extends: { file: "./other.yaml" },
        build: { artifact: ["./build.sh"] },
        "x-path": "./keep",
      },
    },
  };
  // When
  const result = composeIncludeDefaults(document, roots);
  // Then
  expect(result).toMatchObject(document);
});

test.each(["https://example.test/repo.git#main:dir", "git@github.com:example/repo.git", "service:base"])(
  "preserves non-file build context %s",
  (context) => {
    // Given
    const document = { services: { mail: { build: context } } };
    // When
    const result = composeIncludeDefaults(document, roots);
    // Then
    expect(result).toMatchObject(document);
  },
);

test("rebases nested fragment parent paths and retains dot bind sources at the app root", () => {
  // Given
  const document = { services: { mail: { env_file: "../shared/.env", volumes: ["../../:/app"] } } };
  // When
  const result = composeIncludeDefaults(document, { ...roots, sourceRoot: resolve("app/a/b") });
  // Then
  expect(result).toMatchObject({ services: { mail: { env_file: "./a/shared/.env", volumes: [".:/app"] } } });
});

test("rebases override payloads at every path-bearing mapping level without reviving resets", () => {
  // Given
  const document = {
    services: override({
      mail: override({
        volumes: override(["./data:/data", { type: "bind", source: override("./other"), target: "/other" }]),
        env_file: override([".env.mail"]),
        build: override({ context: override("image"), dockerfile: "Dockerfile" }),
        devices: reset(),
      }),
      removed: reset(),
    }),
    configs: override({ config: override({ file: override("config") }), removed: reset() }),
    secrets: override({ secret: { file: reset() } }),
    env_file: reset(),
  };
  // When
  const result = composeIncludeDefaults(document, roots);
  // Then
  expect(result).toEqual({
    services: override({
      mail: override({
        type: "compose",
        appMount: false,
        volumes: override([
          "./mailstack/data:/data",
          { type: "bind", source: override("./mailstack/other"), target: "/other" },
        ]),
        env_file: override(["./mailstack/.env.mail"]),
        build: override({ context: override("./mailstack/image"), dockerfile: "Dockerfile" }),
        devices: reset(),
      }),
      removed: reset(),
    }),
    configs: override({ config: override({ file: override("./mailstack/config") }), removed: reset() }),
    secrets: override({ secret: { file: reset() } }),
    env_file: reset(),
  });
});
