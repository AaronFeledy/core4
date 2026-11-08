import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";

const source = {
  appRoot: "/tmp/shell-param",
  sourceRoot: "/tmp/shell-param",
  sourcePath: "/tmp/shell-param/.lando.yml",
  layer: "canonical" as const,
};

const issueFor = async (value: unknown) => {
  const result = await Effect.runPromise(
    Effect.result(resolveLandofileLoadExpressions({ value, source, policy: DEFAULT_LANDOFILE_LOAD_POLICY })),
  );
  if (!Result.isFailure(result) || !(result.failure instanceof LandofileValidationError))
    throw new Error("Expected a Landofile validation failure");
  return { ...result.failure.issues[0], remediation: result.failure.remediation };
};

test.each([
  [
    { tooling: { test: { cmd: "echo ${HOME}" } } },
    "`${HOME}` at tooling.test.cmd is shell syntax Lando does not expand.",
    'Write $${HOME} to pass it to a container shell, $HOME in a service: ":host" command, or {{ env.HOME }} for your host\'s value.',
  ],
  [
    { events: { "post-start": ["echo ${TAG:-latest}"] } },
    "`${TAG...}` at events.post-start.0 is shell syntax Lando does not expand.",
    'Write $${TAG} to pass it to a container shell, $TAG in a service: ":host" command, or {{ env.TAG }} for your host\'s value.',
  ],
  [
    { tooling: { test: { cmds: [{ cmd: "echo ${HOME}", service: ":host" }] } } },
    "`${HOME}` at tooling.test.cmds.0.cmd is shell syntax Lando does not expand.",
    'Write $${HOME} to pass it to a container shell, $HOME in a service: ":host" command, or {{ env.HOME }} for your host\'s value.',
  ],
  [
    { services: { web: { readiness: { target: "host", command: "test -f ${MARKER}" } } } },
    "`${MARKER}` at services.web.readiness.command is shell syntax Lando does not expand.",
    'Write $${MARKER} to pass it to a container shell, $MARKER in a service: ":host" command, or {{ env.MARKER }} for your host\'s value.',
  ],
  [
    { services: { web: { command: "node ${ENTRY}" } } },
    "`${ENTRY}` at services.web.command is shell syntax Lando does not expand.",
    "Write $${ENTRY} to pass it to the service's shell, or {{ env.ENTRY }} for your host's value.",
  ],
  [
    { tooling: { test: { env: { TOKEN: "${TOKEN}" } } } },
    "`${TOKEN}` at tooling.test.env.TOKEN is shell syntax Lando does not expand.",
    "Write {{ env.TOKEN }} for your host's value, or $${TOKEN} to keep the text as written.",
  ],
  [
    { services: { web: { type: "php:${PHP}" } } },
    "`${PHP}` at services.web.type is shell syntax Lando does not expand.",
    "Write {{ env.PHP }} for your host's value, or $${PHP} to keep the text as written.",
  ],
] as const)("names the shell parameter and a target-aware fix: %j", async (value, message, suggestion) => {
  expect(await issueFor(value)).toMatchObject({
    rule: "unsupported-expression",
    message,
    suggestion,
    remediation: suggestion,
  });
});
