import { expect, test } from "bun:test";
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
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
  {
    path: ["services", "app", "build", "app", 0, "run"],
    extra: "",
    suggestion:
      "Set services.app.environment.TOKEN to the ${secret:...} reference and write $TOKEN in the step. The step's shell reads it from the container environment.",
  },
  {
    path: ["tooling", "task", "cmds", 0, "cmd"],
    extra: "",
    suggestion:
      "Set tooling.task.env.TOKEN to the ${secret:...} reference and write $TOKEN in the command. The shell reads it when the task runs.",
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
      "Use the object form: set events.post-start.0.cmd to this command with $TOKEN in place of the reference, and events.post-start.0.env.TOKEN to the ${secret:...} reference. The shell reads it when the step runs.",
  },
  {
    path: ["events", "post-start", 0, "cmd"],
    extra: "",
    suggestion:
      "Set events.post-start.0.env.TOKEN to the ${secret:...} reference and write $TOKEN in the step's cmd.",
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
      "Set services.app.environment.TOKEN to the ${secret:...} reference and read TOKEN from the environment in your program, or use a string command that reads $TOKEN. Array commands run without a shell.",
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
      "Use ${secret:...} only in a service environment value, a database password, a Redis password, a tooling env value, or an event step env value. Write $${secret:...} to keep the text literal.",
  },
] as const)("provides site-aware guidance at $path", ({ path, extra, suggestion }) => {
  // Given an authored secret at an unsupported site.
  const reference = "TOKEN";
  // When
  const diagnostic = unsupportedSecretReference(path, reference, "${secret:TOKEN}");
  // Then
  expect(diagnostic).toEqual({
    message: `Secret references are not supported at ${path.join(".")}.${extra}`,
    suggestion,
  });
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
  [
    ["services", "app", "build", "args", "bad-key"],
    "op://Vault/Item/field",
    "${secret:op://Vault/Item/field}",
    "SECRET",
  ],
  [["services", "app", "command"], "TOKEN", "${secret:TOKEN}", "TOKEN"],
  [["services", "app", "command"], "op://Vault/Item/field", "${secret:op://Vault/Item/field}", "SECRET"],
  [["services", "app", "command"], "db.pass", "${secret:db.pass}", "SECRET"],
] as const)("derives a safe environment name at %j for %s", (path, reference, value, name) => {
  // Given a map key, list assignment, or secret identifier.
  const buildArgument = path[2] === "build";
  // When
  const diagnostic = unsupportedSecretReference(path, reference, value);
  // Then
  expect(diagnostic).toEqual({
    message: `Secret references are not supported at ${path.join(".")}.${buildArgument ? " Build arguments can be recorded in image history." : ""}`,
    suggestion: buildArgument
      ? `For runtime use, set services.app.environment.${name} to the \${secret:...} reference. For setup that needs it, add an events.post-start step with service app, env.${name} set to the reference, and $${name} in its cmd; it runs in the started container.`
      : `Set services.app.environment.${name} to the \${secret:...} reference. Write $${name} in the command when the service type runs that string as a shell script. On type: compose, the string is split into arguments and is not a shell, so write sh -c with $${name} inside one quoted argument.`,
  });
});
