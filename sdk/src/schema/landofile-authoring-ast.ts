import { SchemaAST as AST, Array as Arr, Schema } from "effect";
import { authoringSource, recordAuthoringSource, recordExpressionSlot } from "./authoring-issue-metadata.ts";
import { authoringSemanticSite } from "./authoring-semantic-site.ts";
import {
  type AuthoringExpressionExpectedType,
  isPlainAuthoringString,
} from "./landofile-authoring-expression.ts";
import { authoringJsonContainer } from "./landofile-authoring-wire.ts";
import { directiveMember } from "./landofile-directive-codec.ts";

export interface DeriveAuthoringOptions {
  readonly partial: boolean;
  readonly slotFor: (kind: AuthoringExpressionExpectedType) => AST.AST;
  readonly rootExpression?: boolean;
  readonly nativeDirectives?: boolean;
  readonly directives?: boolean;
}

const caches = new WeakMap<DeriveAuthoringOptions["slotFor"], Map<string, WeakMap<AST.AST, AST.AST>>>();

const union = (members: readonly AST.AST[], annotations?: Schema.Annotations.Annotations): AST.AST =>
  new AST.Union(
    [
      ...new Set(
        members.flatMap((member) =>
          AST.isUnion(member) &&
          Reflect.ownKeys(member.annotations ?? {}).length === 0 &&
          !member.context &&
          member.checks === undefined &&
          member.encoding === undefined
            ? member.types
            : [member],
        ),
      ),
    ],
    undefined,
    annotations,
  );

const authoringAnnotations = (ast: AST.AST, partial: boolean): Schema.Annotations.Annotations | undefined => {
  const identifier = AST.resolveIdentifier(ast);
  return identifier === undefined
    ? AST.resolve(ast)
    : {
        ...AST.resolve(ast),
        identifier: `${identifier}${partial ? "AuthoringFragment" : "Authoring"}`,
      };
};

const leafKind = (ast: AST.AST): "string" | "number" | "boolean" | undefined => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "Literal": {
      const kind = typeof ast.literal;
      return kind === "string" || kind === "number" || kind === "boolean" ? kind : undefined;
    }
    default:
      return undefined;
  }
};

export const deriveAuthoringAst = (ast: AST.AST, options: DeriveAuthoringOptions): AST.AST =>
  deriveTree(ast, options, true);

const deriveTree = (ast: AST.AST, options: DeriveAuthoringOptions, semantic: boolean): AST.AST => {
  let variants = caches.get(options.slotFor);
  if (variants === undefined) {
    variants = new Map();
    caches.set(options.slotFor, variants);
  }
  const complete = (source: AST.AST): AST.AST =>
    deriveTree(
      source,
      {
        partial: false,
        slotFor: options.slotFor,
        rootExpression: false,
      },
      false,
    );
  const site = (source: AST.AST, annotations: Schema.Annotations.Annotations | undefined) =>
    authoringSemanticSite(source, options.partial ? complete : undefined, annotations);
  const derive = (node: AST.AST, allowExpression: boolean): AST.AST => {
    const key = `${options.partial}:${allowExpression}:${options.directives === true}:${options.nativeDirectives === true}:${semantic}`;
    let memo = variants.get(key);
    if (memo === undefined) {
      memo = new WeakMap();
      variants.set(key, memo);
    }
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    const walked = walk(node, allowExpression);
    const contextual = Schema.make<Schema.Codec<unknown>>(walked).annotateKey(
      node.context?.annotations ?? {},
    );
    const result = AST.isOptional(node) ? Schema.optionalKey(contextual).ast : contextual.ast;
    const source = node.encoding === undefined ? node : AST.toEncoded(node);
    recordAuthoringSource(walked, source);
    recordAuthoringSource(result, source);
    memo.set(node, result);
    return result;
  };
  const member = (node: AST.AST, partialKey = true): AST.AST => {
    const derived = derive(node, true);
    if (!options.directives) {
      if (!options.partial) return derived;
      const partial = Schema.optionalKey(Schema.make<Schema.Codec<unknown>>(derived)).ast;
      recordAuthoringSource(partial, authoringSource(derived) ?? node);
      return partial;
    }
    const schema = directiveMember(
      Schema.make<Schema.Codec<unknown>>(derived),
      options.nativeDirectives === true,
    );
    return (partialKey && options.partial) || AST.isOptional(derived)
      ? Schema.optionalKey(schema).ast
      : schema.ast;
  };
  const slot = (kind: AuthoringExpressionExpectedType): AST.AST => {
    const ast = options.slotFor(kind);
    recordExpressionSlot(ast);
    return ast;
  };
  const walk = (node: AST.AST, allowExpression: boolean): AST.AST => {
    if (node.encoding !== undefined) {
      const authored = derive(Arr.lastNonEmpty(node.encoding).to, allowExpression);
      if (!semantic) return authored;
      // check() copies the AST, keeping the site's ownership separate from the memoized authored node.
      const owned = Schema.make<Schema.Codec<unknown>>(
        AST.isSuspend(authored) ? new AST.Union([authored]) : authored,
      ).check(
        site(node, {
          identifier: AST.resolveIdentifier(authored),
          title: AST.resolveTitle(authored),
          description: AST.resolveDescription(authored),
        }),
      ).ast;
      return owned;
    }
    const kind = leafKind(node);
    if (kind) {
      const leaf =
        kind === "string"
          ? Schema.make<Schema.Codec<string>>(node).check(
              Schema.makeFilter(isPlainAuthoringString, {
                identifier: AST.resolveIdentifier(node),
                title: AST.resolveTitle(node),
                description: AST.resolveDescription(node),
                message: "Expected plain authoring text",
              }),
            ).ast
          : node;
      return allowExpression ? union([leaf, slot(kind)]) : leaf;
    }
    switch (node._tag) {
      case "Declaration": {
        if (node.annotations?.["lando/map-input"] !== true) return node;
        const project = node.annotations.toCodecJson;
        const projection: unknown = typeof project === "function" ? project(node.typeParameters) : undefined;
        return projection instanceof AST.Link ? derive(projection.to, allowExpression) : node;
      }
      case "Objects": {
        const annotations = authoringAnnotations(node, options.partial);
        const object = new AST.Objects(
          node.propertySignatures.map(
            (property) => new AST.PropertySignature(property.name, member(property.type)),
          ),
          node.indexSignatures.map(
            (index) =>
              new AST.IndexSignature(
                index.parameter,
                options.directives ? member(index.type, false) : derive(index.type, true),
              ),
          ),
          annotations,
          semantic && node.checks ? [site(node, undefined)] : undefined,
          undefined,
          node.context,
        );
        const container = authoringJsonContainer(node, object) ?? object;
        recordAuthoringSource(object, node);
        recordAuthoringSource(container, node);
        return allowExpression ? union([container, slot("object")]) : container;
      }
      case "Arrays": {
        const tuple = new AST.Arrays(
          node.isMutable,
          node.elements.map((element) => derive(element, true)),
          node.rest.map((rest) => derive(rest, true)),
          node.annotations,
          semantic && node.checks ? [site(node, undefined)] : undefined,
          undefined,
          node.context,
        );
        const container = authoringJsonContainer(node, tuple) ?? tuple;
        recordAuthoringSource(tuple, node);
        recordAuthoringSource(container, node);
        return allowExpression ? union([container, slot("array")]) : container;
      }
      case "Union":
        return union(
          node.types.map((member) => derive(member, allowExpression)),
          authoringAnnotations(node, options.partial),
        );
      case "Suspend":
        return new AST.Suspend(
          () => derive(node.thunk(), allowExpression),
          node.annotations,
          undefined,
          undefined,
          node.context,
        );
      default:
        return node;
    }
  };
  return derive(ast, options.rootExpression ?? true);
};
