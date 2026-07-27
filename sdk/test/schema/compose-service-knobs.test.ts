import { describe, expect, test } from "bun:test";
import { Either, ParseResult, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

const COMPOSE_SERVICE_KNOB_KEYS = [
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "tmpfs",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "init",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "pull_policy",
  "logging",
  "gpus",
  "deploy",
] as const;

const CAMEL_CASE_ALIASES = [
  "capAdd",
  "capDrop",
  "shmSize",
  "dnsSearch",
  "dnsOpt",
  "extraHosts",
  "stopSignal",
  "stopGracePeriod",
  "securityOpt",
  "groupAdd",
  "readOnly",
  "pullPolicy",
] as const;

type CanonicalCase = readonly [
  label: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
];

const canonicalCases: ReadonlyArray<CanonicalCase> = [
  ["cap_add scalar", { cap_add: "NET_ADMIN" }, { cap_add: ["NET_ADMIN"] }],
  ["cap_drop scalar", { cap_drop: "SYS_ADMIN" }, { cap_drop: ["SYS_ADMIN"] }],
  ["privileged string", { privileged: "true" }, { privileged: "true" }],
  [
    "devices short form",
    { devices: ["/dev/sda:/dev/xvda:rw"] },
    { devices: [{ source: "/dev/sda", target: "/dev/xvda", permissions: "rw" }] },
  ],
  [
    "ulimits integer form",
    { ulimits: { nofile: 65_535 } },
    { ulimits: { nofile: { soft: 65_535, hard: 65_535 } } },
  ],
  [
    "sysctls list form",
    { sysctls: ["net.core.somaxconn=1024"] },
    { sysctls: { "net.core.somaxconn": "1024" } },
  ],
  ["tmpfs scalar", { tmpfs: "/run" }, { tmpfs: ["/run"] }],
  ["shm_size byte string", { shm_size: "64m" }, { shm_size: 67_108_864 }],
  ["dns scalar", { dns: "1.1.1.1" }, { dns: ["1.1.1.1"] }],
  ["dns_search scalar", { dns_search: "example.test" }, { dns_search: ["example.test"] }],
  ["dns_opt scalar", { dns_opt: "use-vc" }, { dns_opt: ["use-vc"] }],
  ["extra_hosts list form", { extra_hosts: ["db:127.0.0.1"] }, { extra_hosts: { db: "127.0.0.1" } }],
  ["init string", { init: "true" }, { init: "true" }],
  ["stop_grace_period duration", { stop_grace_period: "1m30s" }, { stop_grace_period: 90 }],
  ["security_opt scalar", { security_opt: "label=disable" }, { security_opt: ["label=disable"] }],
  ["group_add scalar", { group_add: 1000 }, { group_add: [1000] }],
  ["read_only string", { read_only: "true" }, { read_only: "true" }],
  [
    "GPU options list",
    { gpus: [{ driver: "nvidia", options: ["mode=compute"] }] },
    { gpus: [{ driver: "nvidia", options: { mode: "compute" } }] },
  ],
  [
    "deploy resource byte strings and device options",
    {
      deploy: {
        resources: {
          limits: { memory: "1g" },
          reservations: {
            memory: "512m",
            devices: [{ capabilities: ["gpu"], options: ["mode=compute"] }],
          },
        },
      },
    },
    {
      deploy: {
        resources: {
          limits: { memory: 1_073_741_824 },
          reservations: {
            memory: 536_870_912,
            devices: [{ capabilities: ["gpu"], options: { mode: "compute" } }],
          },
        },
      },
    },
  ],
];

const rejectionCases: ReadonlyArray<readonly [key: string, invalid: unknown]> = [
  ["restart", "sometimes"],
  ["cap_add", 1],
  ["cap_drop", true],
  ["privileged", 1],
  ["devices", ["source-only"]],
  ["ulimits", { nofile: true }],
  ["sysctls", ["missing-separator"]],
  ["tmpfs", 1],
  ["shm_size", "1xb"],
  ["dns", 1],
  ["dns_search", 1],
  ["dns_opt", 1],
  ["extra_hosts", ["missing-separator"]],
  ["init", 1],
  ["stop_signal", true],
  ["stop_grace_period", "soon"],
  ["security_opt", 1],
  ["group_add", false],
  ["read_only", 1],
  ["platform", false],
  ["pull_policy", "sometimes"],
  ["logging", { driver: false }],
  ["gpus", "one"],
  ["deploy", { replicas: 2 }],
];

const decode = (input: unknown) => Schema.decodeUnknownSync(ServiceConfig)(input);
const decodeStrict = (input: unknown) =>
  Schema.decodeUnknownSync(ServiceConfig)(input, { onExcessProperty: "error" });

describe("Compose service runtime knobs", () => {
  test("Given ServiceConfig, when fields are inspected, then every runtime knob uses its verbatim Compose key", () => {
    // Given / When
    const fields = Object.keys(ServiceConfig.fields);

    // Then
    for (const key of COMPOSE_SERVICE_KNOB_KEYS) expect(fields).toContain(key);
    for (const alias of CAMEL_CASE_ALIASES) expect(fields).not.toContain(alias);
  });

  test.each(canonicalCases)(
    "Given %s, when decoded, then its value uses the canonical form",
    (_label, input, expected) => {
      // Given / When
      const defaultDecoded = decode(input);
      const strictDecoded = decodeStrict(input);

      // Then
      expect(defaultDecoded).toEqual(expected);
      expect(strictDecoded).toEqual(expected);
      expect(decode(expected)).toEqual(expected);
      expect(decodeStrict(expected)).toEqual(expected);
    },
  );

  test.each(canonicalCases)("is idempotent for %s", (_label, input) => {
    // Given
    const defaultDecoded = decode(input);
    const strictDecoded = decodeStrict(input);

    // When
    const defaultDecodedAgain = decode(defaultDecoded);
    const strictDecodedAgain = decodeStrict(strictDecoded);

    // Then
    expect(defaultDecodedAgain).toEqual(defaultDecoded);
    expect(strictDecodedAgain).toEqual(strictDecoded);
  });

  test("Given scalar-only knobs, when decoded, then upstream values remain under Compose keys", () => {
    // Given
    const input = {
      restart: "unless-stopped",
      stop_signal: "SIGTERM",
      platform: "linux/amd64",
      pull_policy: "every_12h",
      logging: { driver: "json-file", options: { "max-size": "10m", retries: 2, tag: null } },
    } as const;

    // When / Then
    expect(decodeStrict(input)).toEqual(input);
  });

  test.each(rejectionCases)(
    "Given invalid %s, when decoded, then ParseError reports its issue path",
    (key, invalid) => {
      // Given / When
      const result = Schema.decodeUnknownEither(ServiceConfig)(
        { [key]: invalid },
        {
          onExcessProperty: "error",
        },
      );

      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
        expect(issues.some((issue) => issue.path[0] === key)).toBe(true);
      }
    },
  );

  test.each(["sysctls", "extra_hosts"])(
    "Given a prototype-polluting %s map, when decoded, then the reserved key is rejected",
    (key) => {
      // Given
      const input = { [key]: Object.fromEntries([["__proto__", "polluted"]]) };

      // When
      const defaultResult = Schema.decodeUnknownEither(ServiceConfig)(input);
      const strictResult = Schema.decodeUnknownEither(ServiceConfig)(input, { onExcessProperty: "error" });

      // Then
      for (const result of [defaultResult, strictResult]) {
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) expect(String(result.left)).toContain("__proto__");
      }
    },
  );

  test.each([
    ["sysctls", "KEY=value"],
    ["extra_hosts", "HOST=IP or HOST:IP"],
  ] as const)(
    "Given a %s entry with terminal control bytes, when rejected, then remediation does not echo them",
    (key, remediation) => {
      // Given
      const input = { [key]: ["\u001b]2;CONTROL-INJECTED\u0007"] };

      // When
      const result = Schema.decodeUnknownEither(ServiceConfig)(input);

      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const failure = String(result.left);
        expect(failure).toContain(remediation);
        expect(failure).not.toContain("\u001b");
        expect(failure).not.toContain("\u0007");
      }
    },
  );

  test.each([
    "replicas",
    "placement",
    "update_config",
    "rollback_config",
    "endpoint_mode",
    "mode",
    "labels",
    "restart_policy",
  ])("Given deploy.resources with deploy.%s, when decoded, then resources are not silently erased", (key) => {
    // Given
    const input = {
      deploy: {
        resources: { limits: { memory: "1m" } },
        [key]: key === "replicas" ? 2 : {},
      },
    };

    // When
    const defaultResult = Schema.decodeUnknownEither(ServiceConfig)(input);
    const strictResult = Schema.decodeUnknownEither(ServiceConfig)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isRight(defaultResult)).toBe(true);
    if (Either.isRight(defaultResult)) {
      expect(defaultResult.right.deploy).toEqual({
        resources: { limits: { memory: 1_048_576 } },
      });
    }
    expect(Either.isLeft(strictResult)).toBe(true);
  });
});
