import type { ValidationIssue, ValidationIssuePath } from "@lando/sdk/schema";

const rules = {
  "sensitive-default": {
    message: "Sensitive input must not declare a default.",
    suggestion: "Remove the default and supply the sensitive value at invocation time.",
  },
  "sensitive-choices": {
    message: "Sensitive input must not declare choices.",
    suggestion: "Remove choices and supply the sensitive value at invocation time.",
  },
  "alias-collision": {
    message: "Flag alias collides with another flag name or alias.",
    suggestion: "Choose an alias that is not used by another flag name or alias.",
  },
  "required-default": {
    message: "Required input has a default.",
    suggestion: "Remove the default to require caller input, or remove required to allow the default.",
  },
  "boolean-choices": {
    message: "Boolean flag declares choices.",
    suggestion: "Remove choices; boolean flags accept true or false.",
  },
  "default-outside-choices": {
    message: "Input default is outside its choices.",
    suggestion: "Choose a default from the declared choices, or remove the default.",
  },
  "boolean-default": {
    message: "Boolean flag needs a boolean default.",
    suggestion: "Set default to true or false without quotes, or remove the default.",
  },
  "arguments-disabled": {
    message: "Positional declarations contradict arguments: false.",
    suggestion: "Remove arguments: false to accept declared arguments, or remove the args declarations.",
  },
  "argument-order-missing": {
    message: "Every argument must declare order when any argument does.",
    suggestion: "Give every argument a unique order, or remove all order fields to use declaration order.",
  },
  "argument-order-duplicate": {
    message: "Argument order is duplicated.",
    suggestion: "Assign each argument a distinct order, or remove all order fields.",
  },
  "required-after-optional": {
    message: "Required argument follows an optional argument.",
    suggestion: "Place required arguments before optional arguments in the effective argument order.",
  },
  "reserved-env": {
    message: "Tooling env must not override reserved runtime keys.",
    suggestion: "Remove the LANDO or LANDO_* environment entry; use a name outside that reserved namespace.",
  },
  "wrapper-inputs": {
    message: "Wrapper tasks must not declare flags or args",
    suggestion: "Remove the flags and args declarations, or remove wrapper to bind declared inputs.",
  },
  "wrapper-arguments": {
    message: "Wrapper tasks must accept arguments",
    suggestion: "Remove arguments: false, or remove wrapper.",
  },
  "service-flag": {
    message: "Service reference requires a declared non-boolean flag.",
    suggestion: "Declare the referenced flag without boolean: true, or use a service name or :host.",
  },
  "command-conflict": {
    message: "Use cmd or cmds, not both.",
    suggestion: "Keep cmd for one command or move all commands into cmds and remove cmd.",
  },
  "empty-command": {
    message: "Each command step needs a non-empty cmd.",
    suggestion: "Supply a non-empty command string, or remove the empty step.",
  },
  "wrapper-command-count": {
    message: "A wrapper task runs exactly one command.",
    suggestion: "Keep exactly one command and move setup to another task, or remove wrapper.",
  },
} as const;

export const toolingIssue = (
  path: ValidationIssuePath,
  reason: keyof typeof rules,
  related?: ValidationIssue["related"],
): ValidationIssue => ({ path, reason, ...rules[reason], ...(related === undefined ? {} : { related }) });
