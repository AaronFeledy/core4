import { expect, test } from "bun:test";
import { formatValidationIssuePath } from "@lando/sdk/schema";
import { unsupportedSecretReference } from "../src/unsupported-secret-reference.ts";

test.each([
  {
    path: ["services", "app", "build", "args", "TOKEN"],
    extra: " Build arguments can be recorded in image history.",
    suggestion:
      "For runtime use, set services.app.environment.TOKEN to the ${secret:...} reference. For setup that needs it, add an events.post-start step with service app, env.TOKEN set to the reference, and $TOKEN in its cmd; it runs in the started container.",
  },
  {
    path: ["services", "app", "build", "artifact", 0],
    extra: " Image build steps run before secrets resolve and can be recorded in image history.",
    suggestion:
      "Move this step to services.app.build.app, set services.app.environment.TOKEN to the ${secret:...} reference, and write $TOKEN in the step.",
  },
  {
    path: ["services", "app", "build", "artifact"],
    extra: " Image build steps run before secrets resolve and can be recorded in image history.",
    suggestion:
      "Move this step to services.app.build.app, set services.app.environment.TOKEN to the ${secret:...} reference, and write $TOKEN in the step.",
  },
  {
    path: ["services", "app", "build", "artifact", "run"],
    extra: " Image build steps run before secrets resolve and can be recorded in image history.",
    suggestion:
      "Move this step to services.app.build.app, set services.app.environment.TOKEN to the ${secret:...} reference, and write $TOKEN in the step.",
  },
  {
    path: ["services", "app", "build", "app"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in the step. The step's shell reads it from the container environment.",
  },
  {
    path: ["services", "app", "build", "app", "run"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in the step. The step's shell reads it from the container environment.",
  },
  {
    path: ["services", "app", "build", "app", 0],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in the step. The step's shell reads it from the container environment.",
  },
  {
    path: ["tooling", "task"],
    extra: "",
    suggestion:
      "Use the object form: set tooling.task.cmd to this command with $TOKEN in place of the reference, and tooling.task.env.TOKEN to the ${secret:...} reference. The shell reads it when the task runs.",
  },
  {
    path: ["tooling", "task", "cmd"],
    extra: "",
    suggestion:
      "Set tooling.task.env.TOKEN to the ${secret:...} reference and write $TOKEN in the command. The shell reads it when the task runs.",
  },
  {
    path: ["services", "app", "build", "app", "user"],
    extra: "",
    suggestion:
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, a tooling var env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
  {
    path: ["services", "app", "build", "app", 0, "run"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in the step. The step's shell reads it from the container environment.",
  },
  {
    path: ["tooling", "task", "cmds", 0],
    extra: "",
    suggestion:
      "Set tooling.task.env.TOKEN to the ${secret:...} reference and write $TOKEN in the command. The shell reads it when the task runs.",
  },
  {
    path: ["tooling", "task", "cmds", 0, "cmd"],
    extra: "",
    suggestion:
      "Set tooling.task.cmds[0].env.TOKEN to the ${secret:...} reference and write $TOKEN in the command. The shell reads it when the step runs.",
  },
  {
    path: ["tooling", "task", "cmd", 0],
    extra: "",
    suggestion:
      "Set tooling.task.env.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program, or use a string cmd that reads $TOKEN. Array commands run without a shell.",
  },
  {
    path: ["events", "post-start", 0],
    extra: "",
    suggestion:
      "Use the object form: set events.post-start[0].cmd to this command with $TOKEN in place of the reference, and events.post-start[0].env.TOKEN to the ${secret:...} reference. The shell reads it when the step runs.",
  },
  {
    path: ["events", "post-start", 0, "cmd"],
    extra: "",
    suggestion:
      "Set events.post-start[0].env.TOKEN to the ${secret:...} reference and write $TOKEN in the step's cmd.",
  },
  {
    path: ["events", "post-start", 0, "defer"],
    extra: "",
    suggestion:
      "Set events.post-start[0].env.TOKEN to the ${secret:...} reference and write $TOKEN in the step's deferred command.",
  },
  {
    path: ["services", "app", "build", "dockerfile_inline"],
    extra: " Dockerfile instructions run before secrets resolve and can be recorded in image history.",
    suggestion:
      "For runtime use, set services.app.environment.TOKEN to the ${secret:...} reference. For setup that needs it, add an events.post-start step with service app, env.TOKEN set to the reference, and $TOKEN in its cmd; it runs in the started container.",
  },
  {
    path: ["services", "app", "build", "dockerfileInline"],
    extra: " Dockerfile instructions run before secrets resolve and can be recorded in image history.",
    suggestion:
      "For runtime use, set services.app.environment.TOKEN to the ${secret:...} reference. For setup that needs it, add an events.post-start step with service app, env.TOKEN set to the reference, and $TOKEN in its cmd; it runs in the started container.",
  },
  {
    path: ["services", "app", "command"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference. Write $TOKEN in the command when the service type runs that string as a shell script. On type: compose, the string is split into arguments and is not a shell, so write sh -c with $TOKEN inside one quoted argument.",
  },
  {
    path: ["services", "app", "command", 0],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference. Array commands run without a shell, so read TOKEN from the environment in your program, or use a string command that reads $TOKEN. On type: compose, a string command is split into arguments too, so write sh -c with $TOKEN inside one quoted argument.",
  },
  {
    path: ["services", "app", "entrypoint"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program. A string entrypoint is one program name, not a shell. On type: compose it is split into arguments, so use sh -c with $TOKEN inside one quoted argument when you need a shell.",
  },
  {
    path: ["services", "app", "type"],
    extra: "",
    suggestion:
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, a tooling var env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
  {
    path: ["services", "app", "healthcheck", "command"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in a string healthcheck command. A list command runs without a shell, so the program must read TOKEN from its environment.",
  },
  {
    path: ["services", "app", "readiness", "command"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in a string readiness command. A list command runs without a shell, so the program must read TOKEN from its environment. A readiness probe with target: host runs on the host and receives no secret binding.",
  },
  {
    path: ["services", "app", "readiness", "user"],
    extra: "",
    suggestion:
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, a tooling var env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
  {
    path: ["services", "app", "healthcheck", "interval"],
    extra: "",
    suggestion:
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, a tooling var env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
  ...[["command"], ["raw", 0], ["flags", "TOKEN"], ["args", "TOKEN"]].map((suffix) => ({
    path: ["events", "post-start", 0, ...suffix],
    extra: "",
    suggestion:
      "Lando command inputs cannot carry secrets. Move the work into a cmd step with the secret in that step's env.",
  })),
  {
    path: ["tooling", "task", "vars", "token", "sh"],
    extra: "",
    suggestion:
      "Bind the ${secret:...} reference as TOKEN in the environment of the service that runs the var and write $TOKEN in the var command. A var command that runs on :host receives no Lando secret binding. The var command does not receive the task's env. Set sensitive: true on the var when its output is secret.",
  },
] as const)("provides site-aware guidance at $path", ({ path, extra, suggestion }) => {
  // Given an authored secret at an unsupported site.
  const reference = "TOKEN";
  // When
  const diagnostic = unsupportedSecretReference({
    source: { file: ".lando.yml", layer: "base", path },
    references: [reference],
    value: "${secret:TOKEN}",
  });
  // Then
  expect(diagnostic).toEqual({
    message: `Secret references are not supported at ${formatValidationIssuePath(path)}.${extra}`,
    suggestion,
  });
});

test.each([
  {
    name: "service var command",
    document: { tooling: { task: { vars: { token: { service: "app" } } } } },
    includes: ["services.app.environment.TOKEN", "$TOKEN"],
    excludes: ["tooling.task.env.TOKEN"],
  },
  {
    name: "task-level service var command",
    document: { tooling: { task: { service: "app" } } },
    includes: ["services.app.environment.TOKEN"],
    excludes: ["tooling.task.env.TOKEN"],
  },
  {
    name: "host var command",
    document: { tooling: { task: { vars: { token: { service: ":host" } } } } },
    includes: ["on the host"],
    excludes: ["services.app.environment.TOKEN", "tooling.task.env.TOKEN"],
  },
  {
    name: "unknown flag var target",
    document: { tooling: { task: { service: ":flag" } } },
    includes: ["the service that runs the var", ":host receives no Lando secret binding"],
    excludes: ["services.app.environment.TOKEN", "tooling.task.env.TOKEN"],
  },
  {
    name: "service literally named host",
    document: { tooling: { task: { service: "host" } } },
    includes: ["services.host.environment.TOKEN"],
    excludes: ["on the host"],
  },
  {
    name: "toolingDefaults service var command",
    document: { toolingDefaults: { service: "app" } },
    includes: ["services.app.environment.TOKEN"],
    excludes: ["tooling.task.env.TOKEN"],
  },
])("gives var-command advice for a $name", ({ document, includes, excludes }) => {
  const diagnostic = unsupportedSecretReference({
    source: { file: ".lando.yml", layer: "base", path: ["tooling", "task", "vars", "token", "sh"] },
    references: ["TOKEN"],
    value: "echo ${secret:TOKEN}",
    document,
  });
  for (const token of includes) expect(diagnostic.suggestion).toContain(token);
  for (const token of excludes) expect(diagnostic.suggestion).not.toContain(token);
  expect(diagnostic.suggestion).toContain("sensitive: true");
});

test("gives host-readiness advice that moves the probe into the service", () => {
  const source = {
    file: ".lando.yml",
    layer: "base" as const,
    path: ["services", "app", "readiness", "command"],
  };
  const host = unsupportedSecretReference({
    source,
    references: ["TOKEN"],
    value: "echo ${secret:TOKEN}",
    document: { services: { app: { readiness: { target: "host" } } } },
  });
  expect(host.suggestion).toContain("on the host");
  expect(host.suggestion).toContain("target: service");
  expect(host.suggestion).toContain("services.app.environment.TOKEN");

  const service = unsupportedSecretReference({
    source,
    references: ["TOKEN"],
    value: "echo ${secret:TOKEN}",
    document: { services: { app: { readiness: { target: "service" } } } },
  });
  expect(service.suggestion).toContain("string readiness command");

  for (const document of [
    { services: { app: {} } },
    { services: { app: { readiness: { target: "{{ env.PROBE_TARGET }}" } } } },
  ]) {
    const unresolved = unsupportedSecretReference({
      source,
      references: ["TOKEN"],
      value: "echo ${secret:TOKEN}",
      document,
    });
    expect(unresolved.suggestion).toContain("string readiness command");
    expect(unresolved.suggestion).toContain("target: host runs on the host");
  }

  const healthcheck = unsupportedSecretReference({
    source: { ...source, path: ["services", "app", "healthcheck", "command"] },
    references: ["TOKEN"],
    value: "echo ${secret:TOKEN}",
    document: { services: { app: {} } },
  });
  expect(healthcheck.suggestion).not.toContain("target: host");
});

test.each([
  [
    "command",
    "compose",
    "Set services.app.environment.TOKEN to the ${secret:...} reference. On type: compose, the string is split into arguments and is not a shell, so write sh -c with $TOKEN inside one quoted argument.",
  ],
  [
    "command",
    "node",
    "Set services.app.environment.TOKEN to the ${secret:...} reference. Write $TOKEN in the command. The service type runs that string as a shell script.",
  ],
  [
    "command",
    "{{ env.SERVICE_TYPE }}",
    "Set services.app.environment.TOKEN to the ${secret:...} reference. Write $TOKEN in the command when the service type runs that string as a shell script. On type: compose, the string is split into arguments and is not a shell, so write sh -c with $TOKEN inside one quoted argument.",
  ],
  [
    "entrypoint",
    "compose",
    "Set services.app.environment.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program. On type: compose it is split into arguments, so use sh -c with $TOKEN inside one quoted argument when you need a shell.",
  ],
  [
    "entrypoint",
    "node",
    "Set services.app.environment.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program. A string entrypoint is one program name, not a shell.",
  ],
  [
    "entrypoint",
    "{{ env.SERVICE_TYPE }}",
    "Set services.app.environment.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program. A string entrypoint is one program name, not a shell. On type: compose it is split into arguments, so use sh -c with $TOKEN inside one quoted argument when you need a shell.",
  ],
])("gives only the verified instruction for %s on %s", (field, type, suggestion) => {
  const result = unsupportedSecretReference({
    source: { file: ".lando.yml", layer: "base", path: ["services", "app", field] },
    references: ["TOKEN"],
    value: "echo ${secret:TOKEN}",
    document: { services: { app: { type } } },
    defaultServiceType: "node",
  });
  expect(result.suggestion).toBe(suggestion);
});

test.each([
  [
    ["services", "app", "build", "args", "MAP_KEY"],
    "op://Vault/Item/field",
    "${secret:op://Vault/Item/field}",
    "MAP_KEY",
  ],
  [["services", "app", "build", "args", 0], "db.pass", "TOKEN=prefix-${secret:db.pass}", "TOKEN"],
  [["services", "app", "build", "args", 0], "TOKEN", "bad-key=${secret:TOKEN}", "TOKEN"],
  [["services", "app", "build", "args", "bad-key"], "TOKEN", "${secret:TOKEN}", "TOKEN"],
  [["services", "app", "build", "args", "bad-key"], "TOKEN", "x=${secret:TOKEN}", "TOKEN"],
  [
    ["services", "app", "build", "args", "bad-key"],
    "op://Vault/Item/field",
    "${secret:op://Vault/Item/field}",
    "SECRET",
  ],
  [["services", "app", "command"], "TOKEN", "${secret:TOKEN}", "TOKEN"],
  [["services", "app", "command"], "op://Vault/Item/field", "${secret:op://Vault/Item/field}", "SECRET"],
  [["services", "app", "command"], "db.pass", "${secret:db.pass}", "SECRET"],
  [["services", "app", "command"], "LANDO_TOKEN", "${secret:LANDO_TOKEN}", "SECRET"],
  [["services", "app", "command"], "LANDO", "${secret:LANDO}", "SECRET"],
  [["services", "app", "build", "args", "LANDO_TOKEN"], "TOKEN", "${secret:TOKEN}", "TOKEN"],
] as const)("derives a safe environment name at %j for %s", (path, reference, value, name) => {
  // Given a map key, list assignment, or secret identifier.
  const buildArgument = path[2] === "build";
  // When
  const diagnostic = unsupportedSecretReference({
    source: { file: ".lando.yml", layer: "base", path },
    references: [reference],
    value,
  });
  // Then
  expect(diagnostic.message).toBe(
    `Secret references are not supported at ${formatValidationIssuePath(path)}.${buildArgument ? " Build arguments can be recorded in image history." : ""}`,
  );
  expect(diagnostic.suggestion).toContain(`services.app.environment.${name}`);
  expect(diagnostic.suggestion).toContain(`$${name}`);
  if (buildArgument) expect(diagnostic.suggestion).toContain(`env.${name}`);
});
