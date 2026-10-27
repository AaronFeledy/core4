import type { VariableProps } from "../../sdk/src/docs/components/index.ts";
import type { GuideStepComponent, GuideStepNode } from "./model.ts";

const quote = (value: string): string => JSON.stringify(value);
export const sourceComment = (sourcePath: string, line: number): string =>
  `  // @source: ${sourcePath}:${line}`;
export const renderVariableSetup = (variables: ReadonlyMap<string, VariableProps>): string =>
  [...variables.values()]
    .map((variable) => {
      const display =
        variable.display === undefined ? "" : `\n    // @display: ${variable.name} = ${variable.display}`;
      return `${display}\n    context.vars.set(${quote(variable.name)}, { value: ${quote(variable.value)}${variable.display === undefined ? "" : `, display: ${quote(variable.display)}`} });`;
    })
    .join("\n");

export const renderCleanupFinalizers = (steps: ReadonlyArray<GuideStepNode>, sourcePath: string): string =>
  steps
    .flatMap((step) =>
      step.components
        .filter((component) => component.kind === "Cleanup")
        .map((component) => ({ component, hidden: step.hidden })),
    )
    .map(({ component, hidden }) => {
      const append = 'context.transcript.append({ kind: "cleanup", command: [], exit: 0 })';
      return `${sourceComment(sourcePath, component.line)}\n    yield* Effect.addFinalizer(() => ${hidden ? `context.hidden(${append})` : append});`;
    })
    .join("\n");

const renderRun = (component: Extract<GuideStepComponent, { kind: "Run" }>, sourcePath: string): string => {
  const props = component.props;
  if ("runtime" in props)
    return [
      sourceComment(sourcePath, component.line),
      "    {",
      "      void LandoCore;",
      "      void LandoTesting;",
      props.code
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"),
      "    }",
    ].join("\n");
  if ("command" in props)
    return [
      `    lastRun = yield* context.runCli(${quote(props.command)}, {`,
      `      answers: ${JSON.stringify(props.answers ?? {})},`,
      "    });",
      `    expect(lastRun.exitCode, \`stdout:\\n\${lastRun.stdout}\\nstderr:\\n\${lastRun.stderr}\`).toBe(${props.expectExit ?? 0});`,
    ].join("\n");
  return `    yield* context.shell(${quote(props.shell)});`;
};
const renderVerify = (component: Extract<GuideStepComponent, { kind: "Verify" }>): string => {
  const props = component.props;
  const expected = props.expect === undefined ? undefined : JSON.stringify(props.expect, null, 2);
  if (props.event !== undefined)
    return [
      `    const actual = context.events.find((event) => event._tag === ${quote(props.event)});`,
      `    const matched = ${expected === undefined ? "actual !== undefined" : `matchesExpected(actual, ${expected})`};`,
      `    yield* context.transcript.append({ kind: "verify", target: "event", matched, expected: ${expected ?? quote(props.event)}, actual });`,
      "    expect(matched).toBe(true);",
    ].join("\n");
  if (props.command !== undefined)
    return [
      `    const verifyRun = yield* context.runCli(${quote(props.command)});`,
      `    expect(verifyRun.exitCode, \`stdout:\\n\${verifyRun.stdout}\\nstderr:\\n\${verifyRun.stderr}\`).toBe(${props.expectExit ?? 0});`,
      ...(expected === undefined
        ? []
        : [
            `    expect(matchesExpected({ stdout: verifyRun.stdout, stderr: verifyRun.stderr }, ${expected})).toBe(true);`,
          ]),
    ].join("\n");
  if (props.file !== undefined)
    return [
      `    const fileContent = yield* Effect.promise(() => Bun.file(join(context.testDir, ${quote(props.file)})).text());`,
      `    const matched = ${expected === undefined ? "fileContent !== undefined" : `matchesExpected(fileContent, ${expected})`};`,
      `    yield* context.transcript.append({ kind: "verify", target: "file", matched, expected: ${expected ?? quote(props.file)}, actual: fileContent });`,
      "    expect(matched).toBe(true);",
    ].join("\n");
  return [
    '    const failureText = lastRun === undefined ? "" : `${lastRun.stdout}\\n${lastRun.stderr}`;',
    "    const actual = errorTagFromRun(lastRun);",
    `    const matched = actual === ${quote(props.errorTag ?? "")}${expected === undefined ? "" : ` && matchesExpected(failureText, ${expected})`};`,
    `    yield* context.transcript.append({ kind: "verify", target: "errorTag", matched, expected: ${quote(props.errorTag ?? "")}, actual });`,
    "    expect(matched).toBe(true);",
  ].join("\n");
};
export const renderStepComponent = (component: GuideStepComponent, sourcePath: string): string => {
  if (component.kind === "Variable" || component.kind === "Cleanup") return "";
  if (component.kind === "Run" && "runtime" in component.props) return renderRun(component, sourcePath);
  const body = (() => {
    switch (component.kind) {
      case "Run":
        return renderRun(component, sourcePath);
      case "Verify":
        return renderVerify(component);
      case "UseFixture":
        return `    yield* context.fixtures.use(${quote(component.props.name)});`;
      case "Inline":
        return `    yield* context.transcript.append({ kind: "inline", lang: ${quote(component.props.lang)}, code: ${quote(component.props.code)} });`;
      case "Inspect": {
        const props = component.props;
        const arg =
          props.file !== undefined
            ? `{ file: ${quote(props.file)} }`
            : props.json !== undefined
              ? `{ json: ${quote(props.json)} }`
              : props.events === true
                ? "{ events: true }"
                : "{ output: true }";
        return `    yield* context.inspect(${arg});`;
      }
    }
  })();
  return `${sourceComment(sourcePath, component.line)}\n    {\n${body}\n    }`;
};
