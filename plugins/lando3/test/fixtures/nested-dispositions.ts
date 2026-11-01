import type { DispositionEntry, Golden } from "./disposition-inventory.ts";

const output = (yaml: string, outputPath: readonly string[], value: unknown): Golden => ({
  name: `nested output ${outputPath.join(".")}`,
  yaml,
  expect: { outputPath, ...(value === undefined ? {} : { value }) },
});
const diagnostic = (
  yaml: string,
  keyPath: readonly (string | number)[],
  kind: "dropped" | "needs-review" = "dropped",
): Golden => ({
  name: `nested ${kind} ${keyPath.join(".")}`,
  yaml,
  expect: { kind, keyPath },
});
const service = (fields: string) =>
  `name: inventory\nservices: {s: {api: 4, ${fields.startsWith("image:") ? "" : "image: alpine, "}${fields}}}`;
const catalog = (fields: string) => `name: inventory\nservices: {s: {type: node:22, ${fields}}}`;
const rows = (
  path: readonly string[],
  keys: readonly string[],
  owner: string,
  golden: Golden,
  disposition: DispositionEntry["disposition"] = "target",
): readonly DispositionEntry[] =>
  keys.map((key) => ({ pattern: [...path, key], owner, disposition, golden: [golden] }));

const mountFields = [
  "source",
  "src",
  "target",
  "destination",
  "dest",
  "type",
  "owner",
  "permissions",
  "perms",
  "user",
  "group",
  "content",
  "contents",
  "include",
  "exclude",
  "includes",
  "excludes",
  "read_only",
  "readOnly",
  "scope",
  "instructions",
] as const;
const mount =
  "{source: ./host, src: ./ignored, target: /data, destination: /ignored, dest: /ignored-too, type: copy, owner: root, permissions: '775', perms: '775', user: root, group: root, content: bytes, contents: bytes, include: keep, includes: [keep2], exclude: cache, excludes: [cache2], read_only: false, readOnly: true, scope: app, instructions: echo ignored}";

export const nestedDispositions: readonly DispositionEntry[] = [
  ...rows(
    ["services", "*", "scanner"],
    ["okCodes", "timeout", "retry", "path"],
    "lower-runtime-intent",
    output(
      catalog("scanner: {okCodes: [200], timeout: 1000, retry: 2, path: health}"),
      ["services", "s", "scanner"],
      { okCodes: [200], timeout: 3000, retries: 2, path: "/health" },
    ),
  ),
  {
    pattern: ["services", "*", "home"],
    owner: "lower-runtime-intent",
    disposition: "target",
    golden: [output(service("home: false"), ["services", "s", "home"], false)],
  },
  ...rows(
    ["services", "*", "creds"],
    ["user", "password", "database"],
    "lower-catalog-common",
    output(catalog("creds: {user: app, password: app, database: app}"), ["services", "s", "creds"], {
      user: "app",
      password: "app",
      database: "app",
    }),
  ),
  ...rows(
    ["services", "*", "xdebug"],
    ["mode"],
    "lower-xdebug-object",
    output("services: {s: {type: php:8.3, xdebug: {mode: debug}}}", ["services", "s", "xdebug"], "debug"),
  ),
  ...rows(
    ["services", "*", "healthcheck"],
    ["command", "cmd", "retry", "delay"],
    "lower-api4",
    output(
      service("healthcheck: {command: echo ok, cmd: ignored, retry: 3, delay: 1000}"),
      ["services", "s", "readiness"],
      { command: "echo ok", retries: 3, intervalSeconds: 1 },
    ),
  ),
  ...rows(
    ["services", "*", "image"],
    ["dockerfile"],
    "lower-api4",
    output(service("image: {dockerfile: Dockerfile}"), ["services", "s", "build"], {
      context: ".",
      dockerfile: "Dockerfile",
    }),
  ),
  ...rows(
    ["services", "*", "image", "context", "*"],
    mountFields,
    "lower-api4",
    diagnostic(service(`image: {context: [${mount}]}`), ["services", "s", "image", "context", 0]),
    "drop",
  ),
  ...rows(
    ["services", "*", "image", "steps", "*"],
    ["instructions", "group", "weight", "user"],
    "lower-api4",
    diagnostic(service("image: {steps: [{instructions: echo ok, group: build, weight: 1, user: root}]}"), [
      "services",
      "s",
      "image",
      "steps",
      0,
    ]),
    "drop",
  ),
  ...["mounts", "mount", "storage", "persistent-storage", "appMount", "appmount", "app-mount"].flatMap(
    (key) => {
      const app = ["appMount", "appmount", "app-mount"].includes(key);
      if (key === "storage" || key === "persistent-storage")
        return rows(
          ["services", "*", key, "*"],
          mountFields,
          "lower-api4-mounts",
          diagnostic(service(`${key}: [${mount}]`), ["services", "s", key, 0]),
          "drop",
        );
      const yaml = service(`${key}: ${app ? mount : `[${mount}]`}`);
      return rows(
        ["services", "*", key, ...(app ? [] : ["*"])],
        mountFields,
        "lower-api4-mounts",
        output(
          yaml,
          ["services", "s", app ? "appMount" : "mounts"],
          app
            ? { target: "/data", readOnly: false, excludes: ["cache", "cache2"], includes: ["keep", "keep2"] }
            : [
                { source: "./host", target: "/data", readOnly: false, excludes: ["cache", "cache2"] },
                { source: "./keep", target: "/data/keep" },
                { source: "./keep2", target: "/data/keep2" },
              ],
        ),
      );
    },
  ),
  ...rows(
    ["services", "*", "certs"],
    ["cert", "key"],
    "lower-api4",
    output(service("certs: {cert: cert.pem, key: key.pem}"), ["services", "s", "certs"], {
      cert: "cert.pem",
      key: "key.pem",
    }),
  ),
  ...rows(
    ["services", "*", "security"],
    ["ca", "cas", "certificate-authority", "certificate-authorities"],
    "lower-api4",
    output(
      service(
        "security: {ca: a.pem, cas: b.pem, certificate-authority: c.pem, certificate-authorities: d.pem}",
      ),
      ["services", "s", "security"],
      { ca: ["a.pem", "b.pem", "c.pem", "d.pem"] },
    ),
  ),
  ...rows(
    ["services", "*", "build"],
    ["image", "app", "dockerfile"],
    "build-hooks",
    output(
      service("build: {image: [echo image], app: [echo app], dockerfile: Dockerfile}"),
      ["services", "s", "build"],
      { artifact: [{ run: "echo image" }], app: [{ run: "echo app" }] },
    ),
  ),
  ...rows(
    ["tooling", "*"],
    ["service", "cmd", "description", "dir", "env", "user", "interactive", "disabled"],
    "lower-tooling",
    output(
      "tooling: {task: {service: s, cmd: echo ok, description: Task, dir: /app, env: {A: '1'}, user: root, interactive: false, disabled: false}}",
      ["tooling", "task", "cmd"],
      "echo ok",
    ),
  ),
  ...rows(
    ["proxy", "*", "*"],
    ["hostname", "port", "pathname"],
    "lower-proxy",
    output("proxy: {s: [{hostname: example.test, port: 8080, pathname: /api}]}", ["proxy", "s"], undefined),
  ),
  ...rows(
    ["proxy", "*", "*", "middlewares", "*"],
    ["name", "key", "value"],
    "lower-proxy",
    diagnostic(
      "proxy: {s: [{hostname: example.test, middlewares: [{name: headers, key: value, value: yes}]}]}",
      ["proxy", "s", 0, "middlewares", 0],
    ),
    "drop",
  ),
];
