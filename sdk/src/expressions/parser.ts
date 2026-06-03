import { Effect, Either } from "effect";

import { LandofileExpressionParseError } from "../errors/index.ts";
import type {
  ArrayLiteralExpressionNode,
  CallExpressionNode,
  ConditionalExpressionNode,
  ExpressionNode,
  ExpressionSegment,
  ExpressionTemplate,
  ObjectLiteralEntry,
  ObjectLiteralExpressionNode,
  PathSegment,
} from "./ast.ts";

export interface ParseExpressionOptions {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

interface ParserContext {
  readonly filePath: string;
  readonly source: string;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

const IDENTIFIER_START = /^[A-Za-z_]$/;
const IDENTIFIER_PART = /^[A-Za-z0-9_]$/;
const NUMBER_START = /^\d$/;
const NAMESPACES = new Set(["path", "fs", "url", "semver"]);
const REMEDIATION = "Check the Landofile configuration expression syntax in spec §7.3.1.";

const isIdentifierStart = (char: string | undefined): boolean =>
  char !== undefined && IDENTIFIER_START.test(char);
const isIdentifierPart = (char: string | undefined): boolean =>
  char !== undefined && IDENTIFIER_PART.test(char);
const isNumberStart = (char: string | undefined): boolean => char !== undefined && NUMBER_START.test(char);
const isNamespace = (name: string): boolean => NAMESPACES.has(name);

const toReportedPosition = (position: Position, context: ParserContext): Position => ({
  line: position.line + (context.line ?? 1) - 1,
  column: position.line === 1 ? position.column + (context.column ?? 1) - 1 : position.column,
});

const parseError = (
  context: ParserContext,
  message: string,
  position: Position,
  expression?: string,
  cause?: unknown,
): LandofileExpressionParseError => {
  const reported = toReportedPosition(position, context);
  return new LandofileExpressionParseError({
    message,
    filePath: context.filePath,
    line: reported.line,
    column: reported.column,
    remediation: REMEDIATION,
    ...(expression === undefined ? {} : { expression }),
    ...(cause === undefined ? {} : { cause }),
  });
};

const wrapUnknownParseError = (
  source: string,
  options: ParseExpressionOptions,
  cause: unknown,
): LandofileExpressionParseError =>
  cause instanceof LandofileExpressionParseError
    ? cause
    : new LandofileExpressionParseError({
        message: cause instanceof Error ? cause.message : "Failed to parse Landofile expression.",
        filePath: options.filePath,
        line: undefined,
        column: undefined,
        expression: source,
        remediation: REMEDIATION,
        cause,
      });

class SourceCursor {
  private index = 0;
  private line: number;
  private column: number;

  constructor(
    private readonly source: string,
    position: Position = { line: 1, column: 1 },
  ) {
    this.line = position.line;
    this.column = position.column;
  }

  current(): string | undefined {
    return this.source[this.index];
  }

  peek(offset: number): string | undefined {
    return this.source[this.index + offset];
  }

  startsWith(value: string): boolean {
    return this.source.startsWith(value, this.index);
  }

  isDone(): boolean {
    return this.index >= this.source.length;
  }

  position(): Position {
    return { line: this.line, column: this.column };
  }

  offset(): number {
    return this.index;
  }

  slice(start: number, end: number): string {
    return this.source.slice(start, end);
  }

  advance(count: number): string {
    const start = this.index;
    const end = this.index + count;
    while (this.index < end && this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\r" && this.source[this.index + 1] === "\n") {
        this.index += 2;
        this.line += 1;
        this.column = 1;
        continue;
      }

      this.index += 1;
      if (char === "\n" || char === "\r") {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
    }
    return this.source.slice(start, this.index);
  }
}

type TokenKind = "identifier" | "number" | "string" | "symbol" | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly literal?: string | number;
}

const multiCharSymbols = ["||", "&&", "==", "!=", "<=", ">="] as const;
const singleCharSymbols = new Set(["<", ">", "!", "?", ":", "|", ".", ",", "(", ")", "[", "]", "{", "}"]);

class ExpressionLexer {
  private readonly cursor: SourceCursor;

  constructor(
    private readonly source: string,
    private readonly context: ParserContext,
    position: Position,
  ) {
    this.cursor = new SourceCursor(source, position);
  }

  next(): Token {
    this.skipWhitespace();
    const position = this.cursor.position();
    const char = this.cursor.current();

    if (char === undefined) {
      return { kind: "eof", value: "", line: position.line, column: position.column };
    }

    if (isIdentifierStart(char)) {
      return this.readIdentifier(position);
    }

    if (isNumberStart(char) || (char === "-" && isNumberStart(this.cursor.peek(1)))) {
      return this.readNumber(position);
    }

    if (char === '"' || char === "'") {
      return this.readString(position, char);
    }

    for (const symbol of multiCharSymbols) {
      if (this.cursor.startsWith(symbol)) {
        this.cursor.advance(symbol.length);
        return { kind: "symbol", value: symbol, line: position.line, column: position.column };
      }
    }

    if (singleCharSymbols.has(char)) {
      this.cursor.advance(1);
      return { kind: "symbol", value: char, line: position.line, column: position.column };
    }

    throw parseError(this.context, `Unexpected token "${char}" in expression.`, position, this.source);
  }

  private skipWhitespace(): void {
    while (!this.cursor.isDone()) {
      const char = this.cursor.current();
      if (char === undefined || !/\s/.test(char)) break;
      this.cursor.advance(1);
    }
  }

  private readIdentifier(position: Position): Token {
    const start = this.cursor.offset();
    this.cursor.advance(1);
    while (isIdentifierPart(this.cursor.current())) {
      this.cursor.advance(1);
    }
    return {
      kind: "identifier",
      value: this.cursor.slice(start, this.cursor.offset()),
      line: position.line,
      column: position.column,
    };
  }

  private readNumber(position: Position): Token {
    const start = this.cursor.offset();
    if (this.cursor.current() === "-") {
      this.cursor.advance(1);
    }

    while (isNumberStart(this.cursor.current())) {
      this.cursor.advance(1);
    }

    if (this.cursor.current() === "." && isNumberStart(this.cursor.peek(1))) {
      this.cursor.advance(1);
      while (isNumberStart(this.cursor.current())) {
        this.cursor.advance(1);
      }
    }

    const value = this.cursor.slice(start, this.cursor.offset());
    return { kind: "number", value, literal: Number(value), line: position.line, column: position.column };
  }

  private readString(position: Position, quote: '"' | "'"): Token {
    this.cursor.advance(1);
    let value = "";

    while (!this.cursor.isDone()) {
      const char = this.cursor.current();
      if (char === undefined) break;

      if (char === quote) {
        this.cursor.advance(1);
        return { kind: "string", value, literal: value, line: position.line, column: position.column };
      }

      if (char === "\\") {
        this.cursor.advance(1);
        const escaped = this.cursor.current();
        if (escaped === undefined) break;
        value += this.decodeEscape(escaped, quote);
        this.cursor.advance(1);
        continue;
      }

      value += this.cursor.advance(1);
    }

    throw parseError(this.context, "Unterminated string literal in expression.", position, this.source);
  }

  private decodeEscape(escaped: string, quote: '"' | "'"): string {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === quote || escaped === "\\") return escaped;
    return escaped;
  }
}

interface ExpressionPostfixValue {
  readonly type: "expression";
  readonly expression: ExpressionNode;
  readonly forceAccess: boolean;
}

interface NamespacePostfixValue {
  readonly type: "namespace";
  readonly parts: ReadonlyArray<string>;
  readonly line: number;
  readonly column: number;
}

type PostfixValue = ExpressionPostfixValue | NamespacePostfixValue;

const expressionValue = (expression: ExpressionNode, forceAccess = false): ExpressionPostfixValue => ({
  type: "expression",
  expression,
  forceAccess,
});

const literalNode = (value: string | number | boolean | null): ExpressionNode => ({ kind: "Literal", value });

const callNode = (callee: string, args: ReadonlyArray<ExpressionNode>): CallExpressionNode => ({
  kind: "Call",
  callee,
  args,
});

class ExpressionParser {
  private readonly lexer: ExpressionLexer;
  private current: Token;

  constructor(
    private readonly source: string,
    private readonly context: ParserContext,
    position: Position,
  ) {
    this.lexer = new ExpressionLexer(source, context, position);
    this.current = this.lexer.next();
  }

  parse(): ExpressionNode {
    const expression = this.parseTernary();
    if (this.current.kind !== "eof") {
      this.fail(`Unexpected token "${this.current.value}" after expression.`);
    }
    return expression;
  }

  private parseTernary(): ExpressionNode {
    const test = this.parseOr();
    if (!this.consumeSymbol("?")) return test;

    const consequent = this.parseTernary();
    this.expectSymbol(":");
    const alternate = this.parseTernary();
    return { kind: "Conditional", test, consequent, alternate } satisfies ConditionalExpressionNode;
  }

  private parseOr(): ExpressionNode {
    let expression = this.parseAnd();
    while (this.consumeSymbol("||")) {
      expression = callNode("or", [expression, this.parseAnd()]);
    }
    return expression;
  }

  private parseAnd(): ExpressionNode {
    let expression = this.parseEquality();
    while (this.consumeSymbol("&&")) {
      expression = callNode("and", [expression, this.parseEquality()]);
    }
    return expression;
  }

  private parseEquality(): ExpressionNode {
    let expression = this.parseRelational();
    while (this.current.kind === "symbol" && (this.current.value === "==" || this.current.value === "!=")) {
      const callee = this.current.value === "==" ? "eq" : "ne";
      this.advance();
      expression = callNode(callee, [expression, this.parseRelational()]);
    }
    return expression;
  }

  private parseRelational(): ExpressionNode {
    // Precedence is low-to-high: ternary, ||, &&, equality, relational,
    // unary, pipe, postfix, primary. Pipe binds tighter than comparators,
    // so `a == b | f` desugars to `eq(a, f(b))`.
    let expression = this.parseUnary();
    while (
      this.current.kind === "symbol" &&
      (this.current.value === "<" ||
        this.current.value === ">" ||
        this.current.value === "<=" ||
        this.current.value === ">=")
    ) {
      const callee = this.relationalCallee(this.current.value);
      this.advance();
      expression = callNode(callee, [expression, this.parseUnary()]);
    }
    return expression;
  }

  private parseUnary(): ExpressionNode {
    if (this.consumeSymbol("!")) {
      return callNode("not", [this.parseUnary()]);
    }
    return this.parsePipe();
  }

  private parsePipe(): ExpressionNode {
    let expression = this.parsePostfix();
    while (this.consumeSymbol("|")) {
      expression = this.parsePipeCall(expression);
    }
    return expression;
  }

  private parsePostfix(): ExpressionNode {
    let value = this.parsePrimaryValue();

    while (this.current.kind === "symbol") {
      if (this.current.value === ".") {
        this.advance();
        const member = this.expectIdentifier("Expected property name after '.'.");
        value = this.appendMember(value, member);
        continue;
      }

      if (this.current.value === "[") {
        this.advance();
        value = this.appendIndex(value);
        continue;
      }

      if (this.current.value === "(") {
        const callPosition = { line: this.current.line, column: this.current.column };
        this.advance();
        value = expressionValue(this.callFromPostfix(value, this.parseArguments(), callPosition));
        continue;
      }

      break;
    }

    if (value.type === "namespace") {
      throw parseError(
        this.context,
        `Namespaced function "${value.parts.join(".")}" must be called.`,
        { line: value.line, column: value.column },
        this.source,
      );
    }

    return value.expression;
  }

  private parsePrimaryValue(): PostfixValue {
    const token = this.current;

    if (token.kind === "identifier") {
      this.advance();
      if (token.value === "true") return expressionValue(literalNode(true));
      if (token.value === "false") return expressionValue(literalNode(false));
      if (token.value === "null") return expressionValue(literalNode(null));
      if (isNamespace(token.value)) {
        return { type: "namespace", parts: [token.value], line: token.line, column: token.column };
      }
      return expressionValue({ kind: "Path", head: token.value, segments: [] });
    }

    if (token.kind === "number") {
      this.advance();
      return expressionValue(
        literalNode(typeof token.literal === "number" ? token.literal : Number(token.value)),
      );
    }

    if (token.kind === "string") {
      this.advance();
      return expressionValue(literalNode(typeof token.literal === "string" ? token.literal : token.value));
    }

    if (this.consumeSymbol("[")) {
      return expressionValue(this.parseArrayLiteral());
    }

    if (this.consumeSymbol("{")) {
      return expressionValue(this.parseObjectLiteral());
    }

    if (this.consumeSymbol("(")) {
      const expression = this.parseTernary();
      this.expectSymbol(")");
      return expressionValue(expression, true);
    }

    this.fail("Expected expression.");
  }

  private parseArrayLiteral(): ArrayLiteralExpressionNode {
    const elements: ExpressionNode[] = [];
    if (this.consumeSymbol("]")) return { kind: "ArrayLiteral", elements };

    while (true) {
      elements.push(this.parseTernary());
      if (this.consumeSymbol("]")) break;
      this.expectSymbol(",");
      if (this.consumeSymbol("]")) break;
    }

    return { kind: "ArrayLiteral", elements };
  }

  private parseObjectLiteral(): ObjectLiteralExpressionNode {
    const entries: ObjectLiteralEntry[] = [];
    if (this.consumeSymbol("}")) return { kind: "ObjectLiteral", entries };

    while (true) {
      const key = this.parseObjectKey();
      this.expectSymbol(":");
      entries.push({ key, value: this.parseTernary() });
      if (this.consumeSymbol("}")) break;
      this.expectSymbol(",");
      if (this.consumeSymbol("}")) break;
    }

    return { kind: "ObjectLiteral", entries };
  }

  private parseObjectKey(): string {
    const token = this.current;
    if (token.kind === "identifier" || token.kind === "string") {
      this.advance();
      return typeof token.literal === "string" ? token.literal : token.value;
    }
    this.fail("Expected object literal key.");
  }

  private parsePipeCall(input: ExpressionNode): ExpressionNode {
    const token = this.current;
    if (token.kind !== "identifier") {
      this.fail("Expected filter or helper name after '|'.");
    }

    const parts: string[] = [token.value];
    this.advance();
    while (this.consumeSymbol(".")) {
      parts.push(this.expectIdentifier("Expected namespaced helper name after '.'."));
    }

    const first = parts[0];
    if (first === undefined) {
      this.fail("Expected filter or helper name after '|'.");
    }
    if (parts.length > 1 && !isNamespace(first)) {
      throw parseError(
        this.context,
        `Dotted helper "${parts.join(".")}" must use one of the reserved namespaces.`,
        { line: token.line, column: token.column },
        this.source,
      );
    }
    if (parts.length === 1 && isNamespace(first)) {
      throw parseError(
        this.context,
        `Reserved namespace "${first}" must name a helper.`,
        { line: token.line, column: token.column },
        this.source,
      );
    }

    const args = this.consumeSymbol("(") ? this.parseArguments() : [];
    return callNode(parts.join("."), [input, ...args]);
  }

  private appendMember(value: PostfixValue, member: string): PostfixValue {
    if (value.type === "namespace") {
      return { ...value, parts: [...value.parts, member] };
    }

    return this.appendAccessSegment(value, { type: "prop", name: member });
  }

  private appendIndex(value: PostfixValue): PostfixValue {
    if (value.type !== "expression") {
      this.fail("Bracket access is only supported on expressions.");
    }

    const keyExpression = this.parseTernary();
    this.expectSymbol("]");
    return this.appendAccessSegment(value, this.pathSegmentFromIndexExpression(keyExpression));
  }

  private appendAccessSegment(value: ExpressionPostfixValue, segment: PathSegment): PostfixValue {
    if (value.expression.kind === "Path" && !value.forceAccess) {
      return expressionValue({ ...value.expression, segments: [...value.expression.segments, segment] });
    }

    if (value.expression.kind === "Access") {
      return expressionValue({ ...value.expression, segments: [...value.expression.segments, segment] });
    }

    return expressionValue({ kind: "Access", target: value.expression, segments: [segment] });
  }

  private pathSegmentFromIndexExpression(expression: ExpressionNode): PathSegment {
    if (expression.kind === "Literal" && typeof expression.value === "number") {
      if (!Number.isInteger(expression.value)) {
        this.fail("Numeric path indexes must be integers.");
      }
      return { type: "index", index: expression.value };
    }

    if (expression.kind === "Literal" && typeof expression.value === "string") {
      return { type: "key", key: expression.value };
    }

    return { type: "dynamic", expr: expression };
  }

  private callFromPostfix(
    value: PostfixValue,
    args: ReadonlyArray<ExpressionNode>,
    position: Position,
  ): CallExpressionNode {
    if (value.type === "namespace") {
      const first = value.parts[0];
      if (first === undefined || value.parts.length < 2) {
        throw parseError(this.context, "Reserved namespace calls must name a helper.", position, this.source);
      }
      return callNode(value.parts.join("."), args);
    }

    if (value.expression.kind === "Path" && value.expression.segments.length === 0) {
      return callNode(value.expression.head, args);
    }

    throw parseError(
      this.context,
      "Only bare helpers and namespaced helpers can be called.",
      position,
      this.source,
    );
  }

  private parseArguments(): ReadonlyArray<ExpressionNode> {
    const args: ExpressionNode[] = [];
    if (this.consumeSymbol(")")) return args;

    while (true) {
      args.push(this.parseTernary());
      if (this.consumeSymbol(")")) break;
      this.expectSymbol(",");
      if (this.consumeSymbol(")")) break;
    }

    return args;
  }

  private relationalCallee(operator: string): "lt" | "gt" | "le" | "ge" {
    if (operator === "<") return "lt";
    if (operator === ">") return "gt";
    if (operator === "<=") return "le";
    return "ge";
  }

  private consumeSymbol(symbol: string): boolean {
    if (this.current.kind === "symbol" && this.current.value === symbol) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectSymbol(symbol: string): void {
    if (!this.consumeSymbol(symbol)) {
      this.fail(`Expected '${symbol}'.`);
    }
  }

  private expectIdentifier(message: string): string {
    const token = this.current;
    if (token.kind !== "identifier") {
      this.fail(message);
    }
    this.advance();
    return token.value;
  }

  private advance(): void {
    this.current = this.lexer.next();
  }

  private fail(message: string): never {
    throw parseError(
      this.context,
      message,
      { line: this.current.line, column: this.current.column },
      this.source,
    );
  }
}

class TemplateParser {
  private readonly cursor: SourceCursor;
  private readonly segments: ExpressionSegment[] = [];
  private literal = "";

  constructor(private readonly context: ParserContext) {
    this.cursor = new SourceCursor(context.source);
  }

  parse(): ExpressionTemplate {
    while (!this.cursor.isDone()) {
      if (this.cursor.startsWith("{{{{")) {
        this.literal += "{{";
        this.cursor.advance(4);
        continue;
      }

      if (this.cursor.startsWith("$${")) {
        this.literal += "${";
        this.cursor.advance(3);
        continue;
      }

      if (this.cursor.startsWith("{{")) {
        this.parseTemplateTag();
        continue;
      }

      if (this.cursor.startsWith("${")) {
        this.parseBracedShellSegment();
        continue;
      }

      if (this.cursor.current() === "$" && isIdentifierStart(this.cursor.peek(1))) {
        this.parseBareShellSegment();
        continue;
      }

      this.literal += this.cursor.advance(1);
    }

    this.flushLiteral();
    return {
      whole: this.segments.length === 1 && this.segments[0]?.kind === "InterpolationSegment",
      segments: this.segments,
    };
  }

  private parseTemplateTag(): void {
    this.flushLiteral();
    const start = this.cursor.position();
    this.cursor.advance(2);

    if (this.cursor.current() === "#") {
      this.parseCommentTag(start);
      return;
    }

    let trimLeft = false;
    if (this.cursor.current() === "-") {
      trimLeft = true;
      this.cursor.advance(1);
    }

    const expressionStart = this.cursor.offset();
    const expressionPosition = this.cursor.position();
    const { expression, trimRight } = this.readInterpolationExpression(start, expressionStart);
    const parser = new ExpressionParser(expression, this.context, expressionPosition);
    this.segments.push({
      kind: "InterpolationSegment",
      expression: parser.parse(),
      trimLeft,
      trimRight,
    });
  }

  private parseCommentTag(start: Position): void {
    this.cursor.advance(1);
    const textStart = this.cursor.offset();

    while (!this.cursor.isDone()) {
      if (this.cursor.startsWith("#}}")) {
        const text = this.cursor.slice(textStart, this.cursor.offset());
        this.cursor.advance(3);
        this.segments.push({ kind: "CommentSegment", text });
        return;
      }
      this.cursor.advance(1);
    }

    throw parseError(this.context, "Unterminated expression comment.", start, this.context.source);
  }

  private readInterpolationExpression(
    start: Position,
    expressionStart: number,
  ): { readonly expression: string; readonly trimRight: boolean } {
    let quote: '"' | "'" | undefined;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;

    while (!this.cursor.isDone()) {
      const char = this.cursor.current();
      if (char === undefined) break;

      if (quote !== undefined) {
        if (char === "\\") {
          this.cursor.advance(1);
          if (!this.cursor.isDone()) {
            this.cursor.advance(1);
          }
          continue;
        }
        if (char === quote) {
          quote = undefined;
        }
        this.cursor.advance(1);
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        this.cursor.advance(1);
        continue;
      }

      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (this.cursor.startsWith("-}}")) {
          const expression = this.cursor.slice(expressionStart, this.cursor.offset());
          this.cursor.advance(3);
          return { expression, trimRight: true };
        }
        if (this.cursor.startsWith("}}")) {
          const expression = this.cursor.slice(expressionStart, this.cursor.offset());
          this.cursor.advance(2);
          return { expression, trimRight: false };
        }
      }

      if (char === "(") parenDepth += 1;
      if (char === ")" && parenDepth > 0) parenDepth -= 1;
      if (char === "[") bracketDepth += 1;
      if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
      if (char === "{") braceDepth += 1;
      if (char === "}" && braceDepth > 0) braceDepth -= 1;
      this.cursor.advance(1);
    }

    throw parseError(this.context, "Unterminated interpolation expression.", start, this.context.source);
  }

  private parseBracedShellSegment(): void {
    this.flushLiteral();
    const start = this.cursor.position();
    this.cursor.advance(2);
    const contentStart = this.cursor.offset();

    while (!this.cursor.isDone()) {
      if (this.cursor.current() === "}") {
        const content = this.cursor.slice(contentStart, this.cursor.offset());
        this.cursor.advance(1);
        this.segments.push(parseShellSegment(content, this.context, start));
        return;
      }
      this.cursor.advance(1);
    }

    throw parseError(this.context, "Unterminated shell parameter expression.", start, this.context.source);
  }

  private parseBareShellSegment(): void {
    this.flushLiteral();
    this.cursor.advance(1);
    const start = this.cursor.offset();
    while (isIdentifierPart(this.cursor.current())) {
      this.cursor.advance(1);
    }
    this.segments.push({
      kind: "ShellParamSegment",
      name: this.cursor.slice(start, this.cursor.offset()),
      operator: "plain",
    });
  }

  private flushLiteral(): void {
    if (this.literal === "") return;
    this.segments.push({ kind: "LiteralSegment", text: this.literal });
    this.literal = "";
  }
}

const parseShellSegment = (
  content: string,
  context: ParserContext,
  position: Position,
): ExpressionSegment => {
  if (content.startsWith("secret:")) {
    const name = content.slice("secret:".length);
    if (name === "") {
      throw parseError(context, "Secret references must include a key.", position, content);
    }
    return { kind: "SecretRefSegment", name };
  }

  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(content);
  if (match === null) {
    throw parseError(context, "Shell parameter names must be identifiers.", position, content);
  }

  const name = match[0];
  const rest = content.slice(name.length);
  if (rest === "") return { kind: "ShellParamSegment", name, operator: "plain" };
  if (rest.startsWith(":-"))
    return { kind: "ShellParamSegment", name, operator: "default-empty", word: rest.slice(2) };
  if (rest.startsWith("-"))
    return { kind: "ShellParamSegment", name, operator: "default-unset", word: rest.slice(1) };
  if (rest.startsWith(":?"))
    return { kind: "ShellParamSegment", name, operator: "error", word: rest.slice(2) };
  if (rest.startsWith(":+")) return { kind: "ShellParamSegment", name, operator: "alt", word: rest.slice(2) };

  throw parseError(context, `Unsupported shell parameter operator "${rest}".`, position, content);
};

const parseExpressionSync = (source: string, options: ParseExpressionOptions): ExpressionTemplate =>
  new TemplateParser({
    filePath: options.filePath,
    line: options.line,
    column: options.column,
    source,
  }).parse();

export const parseExpression = (
  source: string,
  options: ParseExpressionOptions,
): Effect.Effect<ExpressionTemplate, LandofileExpressionParseError> =>
  Effect.try({
    try: () => parseExpressionSync(source, options),
    catch: (cause) => wrapUnknownParseError(source, options, cause),
  });

export const parseExpressionEither = (
  source: string,
  options: ParseExpressionOptions,
): Either.Either<ExpressionTemplate, LandofileExpressionParseError> => {
  try {
    return Either.right(parseExpressionSync(source, options));
  } catch (cause) {
    return Either.left(wrapUnknownParseError(source, options, cause));
  }
};
