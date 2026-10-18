import { HealthcheckInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

const ignoredComposeKeys = {
  test: ["FOO", "x"],
  disable: "yes",
  interval: "bad",
  timeout: "bad",
  start_period: "bad",
} as const;

export const table = {
  name: "HealthcheckInput",
  schema: HealthcheckInput,
  accepted: [
    { name: "false disables the probe", input: false, expected: false },
    { name: "bare NONE is an executable", input: ["NONE"], expected: { kind: "command", command: ["NONE"] } },
    {
      name: "none drops probe targets and timings",
      input: {
        kind: "none",
        command: "x",
        url: "http://x",
        port: 80,
        intervalSeconds: 2,
        startInterval: "5s",
      },
      expected: false,
    },
    {
      name: "disable ignores test and timings",
      input: { disable: true, test: "x", interval: "5s", start_interval: "1s" },
      expected: false,
    },
    {
      name: "string is a shell command",
      input: "pg_isready",
      expected: { kind: "command", command: "pg_isready" },
    },
    {
      name: "bare argv keeps Compose markers literal",
      input: ["CMD", "true"],
      expected: { kind: "command", command: ["CMD", "true"] },
    },
    {
      name: "object command",
      input: { kind: "command", command: ["true"] },
      expected: { kind: "command", command: ["true"] },
    },
    {
      name: "Compose CMD test preserves direct argv",
      input: { test: ["CMD", "curl", "-f", "localhost"] },
      expected: { kind: "command", command: ["curl", "-f", "localhost"] },
    },
    {
      name: "Compose shell test string",
      input: { test: "curl -f localhost" },
      expected: { kind: "command", command: "curl -f localhost" },
    },
    {
      name: "CMD-SHELL preserves a command without pre-wrapping sh -c",
      input: { test: ["CMD-SHELL", "echo ready"] },
      expected: { kind: "command", command: "echo ready" },
    },
    { name: "NONE test disables the probe", input: { test: ["NONE"], interval: "5s" }, expected: false },
    {
      name: "Compose disable true",
      input: { disable: true, test: "x" },
      expected: false,
    },
    {
      name: "Compose durations normalize to fractional seconds",
      input: { test: ["CMD", "true"], interval: "500ms", timeout: "1m30s", start_period: "1h2m3s" },
      expected: {
        kind: "command",
        command: ["true"],
        intervalSeconds: 0.5,
        timeoutSeconds: 90,
        startPeriodSeconds: 3723,
      },
    },
    {
      name: "url object form",
      input: { url: "http://localhost/health" },
      expected: { url: "http://localhost/health" },
    },
    {
      name: "port object form",
      input: { port: 8080 },
      expected: { port: 8080 },
    },
    { name: "start_interval stays raw", input: { start_interval: "5s" }, expected: { startInterval: "5s" } },
    {
      name: "none discards ignored Compose keys",
      input: { ...ignoredComposeKeys, kind: "none", retries: "3", start_interval: "5s" },
      expected: false,
    },
    {
      name: "command selects Lando precedence over disable",
      input: { command: ["true"], disable: true },
      expected: { kind: "command", command: ["true"] },
    },
    {
      name: "url selects Lando precedence",
      input: { ...ignoredComposeKeys, url: "http://localhost/health" },
      expected: { url: "http://localhost/health" },
    },
    {
      name: "port selects Lando precedence",
      input: { ...ignoredComposeKeys, port: 8080 },
      expected: { port: 8080 },
    },
    {
      name: "intervalSeconds selects Lando precedence",
      input: { intervalSeconds: 7, interval: "30s" },
      expected: { intervalSeconds: 7 },
    },
    {
      name: "timeoutSeconds selects Lando precedence",
      input: { ...ignoredComposeKeys, timeoutSeconds: 8 },
      expected: { timeoutSeconds: 8 },
    },
    {
      name: "startPeriodSeconds selects Lando precedence",
      input: { ...ignoredComposeKeys, startPeriodSeconds: 9 },
      expected: { startPeriodSeconds: 9 },
    },
    { name: "boolean true disables", input: { disable: true }, expected: false },
    { name: "string true disables", input: { disable: "true" }, expected: false },
    { name: "uppercase TRUE disables", input: { disable: "TRUE" }, expected: false },
    { name: "trimmed true disables", input: { disable: " true " }, expected: false },
    { name: "boolean false has no effect", input: { disable: false }, expected: {} },
    { name: "string false has no effect", input: { disable: "false" }, expected: {} },
    { name: "numeric retries", input: { retries: 3 }, expected: { retries: 3 } },
    { name: "decimal-integer retries", input: { retries: "3" }, expected: { retries: 3 } },
  ],
  rejected: [
    { name: "empty shorthand string", input: "", expectedErrorFragment: "must not be empty" },
    { name: "empty shorthand argv", input: [], expectedErrorFragment: "must not be empty" },
    { name: "true shorthand", input: true, expectedErrorFragment: "Expected false, a command string" },
    { name: "empty test array", input: { test: [] }, expectedErrorFragment: "CMD" },
    { name: "NONE extra arguments", input: { test: ["NONE", "x"] }, expectedErrorFragment: "NONE" },
    { name: "CMD requires argv", input: { test: ["CMD"] }, expectedErrorFragment: "CMD" },
    {
      name: "CMD-SHELL requires a command",
      input: { test: ["CMD-SHELL"] },
      expectedErrorFragment: "CMD-SHELL",
    },
    {
      name: "CMD-SHELL extra arguments",
      input: { test: ["CMD-SHELL", "a", "b"] },
      expectedErrorFragment: "CMD-SHELL",
    },
    { name: "unknown test marker", input: { test: ["FOO", "x"] }, expectedErrorFragment: "CMD-SHELL" },
    { name: "invalid interval", input: { interval: "5x" }, expectedErrorFragment: "30s" },
    { name: "invalid timeout", input: { timeout: "30 seconds" }, expectedErrorFragment: "30s" },
    { name: "invalid start_period", input: { start_period: "-5s" }, expectedErrorFragment: "30s" },
    {
      name: "unsupported disable string",
      input: { disable: "yes" },
      expectedErrorFragment: '"true" or "false"',
    },
    { name: "fractional retries", input: { retries: "3.5" }, expectedErrorFragment: "retries" },
    { name: "negative retries", input: { retries: "-1" }, expectedErrorFragment: "retries" },
    { name: "hex retries", input: { retries: "0x10" }, expectedErrorFragment: "retries" },
    { name: "whitespace retries", input: { retries: " 3 " }, expectedErrorFragment: "retries" },
    { name: "exponent retries", input: { retries: "1e3" }, expectedErrorFragment: "retries" },
    { name: "empty retries", input: { retries: "" }, expectedErrorFragment: "retries" },
  ],
} as const satisfies NamedContractTable;
