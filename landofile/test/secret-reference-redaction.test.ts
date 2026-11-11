import { expect, test } from "bun:test";
import { encodeCommandResult } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import { CommandResultEnvelope, type ValidationFix, ValidationIssue } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";

const commandFix: ValidationFix = {
  edits: [
    { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
    { op: "set", path: ["tooling", "deploy", "cmd"], value: 'echo Bearer "$TOKEN"' },
  ],
};
const cases: readonly {
  readonly label: string;
  readonly document: unknown;
  readonly fix?: ValidationFix;
}[] = [
  { label: "token flag", document: { tooling: { deploy: { cmd: "curl --token=${secret:TOKEN}" } } } },
  { label: "assignment", document: { tooling: { deploy: { cmd: "TOKEN=${secret:TOKEN} ./run" } } } },
  {
    label: "URL password",
    document: { tooling: { deploy: { cmd: "curl https://user:${secret:TOKEN}@host" } } },
  },
  {
    label: "identifier suffix",
    document: { tooling: { deploy: { cmd: "echo ${secret:TOKEN}suffix" } } },
    fix: {
      edits: [
        { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
        { op: "set", path: ["tooling", "deploy", "cmd"], value: 'echo "$TOKEN"suffix' },
      ],
    },
  },
  {
    label: "digit suffix",
    document: { tooling: { deploy: { cmd: "echo ${secret:TOKEN}1" } } },
    fix: {
      edits: [
        { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
        { op: "set", path: ["tooling", "deploy", "cmd"], value: 'echo "$TOKEN"1' },
      ],
    },
  },
  {
    label: "underscore suffix",
    document: { tooling: { deploy: { cmd: "echo ${secret:TOKEN}_" } } },
    fix: {
      edits: [
        { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
        { op: "set", path: ["tooling", "deploy", "cmd"], value: 'echo "$TOKEN"_' },
      ],
    },
  },
  { label: "single quotes", document: { tooling: { deploy: { cmd: "echo '${secret:TOKEN}'" } } } },
  { label: "backslash escape", document: { tooling: { deploy: { cmd: "echo \\${secret:TOKEN}" } } } },
  { label: "double-quoted escape", document: { tooling: { deploy: { cmd: 'echo "\\${secret:TOKEN}"' } } } },
  { label: "tooling shorthand", document: { tooling: { deploy: "echo Bearer ${secret:TOKEN}" } } },
  {
    label: "templated service type",
    document: { services: { app: { type: "{{ env.SERVICE_TYPE }}", command: "echo ${secret:TOKEN}" } } },
  },
  {
    label: "Bearer command",
    document: { tooling: { deploy: { cmd: "echo Bearer ${secret:TOKEN}" } } },
    fix: commandFix,
  },
  {
    label: "event shorthand",
    document: { events: { "post-start": ["echo Bearer ${secret:DEPLOY_TOKEN}"] } },
    fix: {
      edits: [
        { op: "set", path: ["events", "post-start", 0], value: { cmd: 'echo Bearer "$DEPLOY_TOKEN"' } },
        {
          op: "set",
          path: ["events", "post-start", 0, "env", "DEPLOY_TOKEN"],
          value: "${secret:DEPLOY_TOKEN}",
        },
      ],
    },
  },
];

test.each(cases)(
  "emits only complete byte-identical fixes after both redaction surfaces: $label",
  async ({ document, fix }) => {
    // Given
    const redactor = createRedactor("secrets");
    // When
    const failure = await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: document,
        source: {
          appRoot: "/tmp/fix-redaction",
          sourceRoot: "/tmp/fix-redaction",
          sourcePath: "/tmp/fix-redaction/.lando.yml",
          layer: "base",
        },
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      }).pipe(Effect.flip),
    );
    if (!(failure instanceof LandofileValidationError)) throw failure;
    const textIssues = Schema.decodeUnknownSync(Schema.Array(ValidationIssue))(
      redactor.redactValue(failure.issues),
    );
    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "app:config:lint",
        resultSchema: Schema.Array(ValidationIssue),
        outcome: { _tag: "success", value: failure.issues },
        redactor,
      }),
    );
    const envelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope))(encoded);
    const machineIssues = Schema.decodeUnknownSync(Schema.Array(ValidationIssue))(envelope.result);
    // Then
    expect(failure.issues).toHaveLength(1);
    expect(textIssues).toHaveLength(1);
    expect(machineIssues).toHaveLength(1);
    expect(failure.issues[0]?.fix).toEqual(fix);
    expect(textIssues[0]?.fix).toEqual(fix);
    expect(machineIssues[0]?.fix).toEqual(fix);
  },
);
