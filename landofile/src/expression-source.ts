import type { ExpressionNode, ExpressionTemplate, PathSegment } from "@lando/sdk/expressions";

const segmentsSource = (segments: readonly PathSegment[]): string =>
  segments
    .map((segment) => {
      switch (segment.type) {
        case "prop":
          return `.${segment.name}`;
        case "key":
          return `[${JSON.stringify(segment.key)}]`;
        case "index":
          return `[${segment.index}]`;
        case "dynamic":
          return `[${expressionSource(segment.expr)}]`;
        default:
          return segment satisfies never;
      }
    })
    .join("");

export const expressionSource = (node: ExpressionNode): string => {
  switch (node.kind) {
    case "Literal":
      return JSON.stringify(node.value);
    case "Path":
      return node.head + segmentsSource(node.segments);
    case "Access":
      return `(${expressionSource(node.target)})${segmentsSource(node.segments)}`;
    case "ArrayLiteral":
      return `[${node.elements.map(expressionSource).join(", ")}]`;
    case "ObjectLiteral":
      return `{ ${node.entries.map((entry) => `${JSON.stringify(entry.key)}: ${expressionSource(entry.value)}`).join(", ")} }`;
    case "Call":
      return `${node.callee}(${node.args.map(expressionSource).join(", ")})`;
    case "Conditional":
      return `${expressionSource(node.test)} ? ${expressionSource(node.consequent)} : ${expressionSource(node.alternate)}`;
    default:
      return node satisfies never;
  }
};

export const literalSource = (text: string): string =>
  text.replaceAll("{{", () => "{{{{").replaceAll("${", () => "$${");

export const templateSource = (template: ExpressionTemplate): string =>
  template.segments
    .map((segment) => {
      switch (segment.kind) {
        case "LiteralSegment":
          return literalSource(segment.text);
        case "CommentSegment":
          return `{{! ${segment.text} }}`;
        case "InterpolationSegment":
          return `{{${segment.trimLeft ? "-" : ""} ${expressionSource(segment.expression)} ${segment.trimRight ? "-" : ""}}}`;
        case "SecretRefSegment":
          return `\${secret:${segment.name}}`;
        case "ShellParamSegment": {
          const operators = {
            plain: "",
            "default-empty": ":-",
            "default-unset": "-",
            error: ":?",
            alt: ":+",
          } as const;
          return `\${${segment.name}${operators[segment.operator]}${segment.word ?? ""}}`;
        }
        default:
          return segment satisfies never;
      }
    })
    .join("");
