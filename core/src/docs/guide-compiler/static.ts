type EsNode = { readonly type: string; readonly [key: string]: unknown };

const literalOf = (node: EsNode | undefined): string | number | boolean | undefined => {
  if (node?.type === "Literal") {
    const value = node.value;
    return typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
      ? value
      : undefined;
  }
  if (node?.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const raw = (node.quasis as { value: { raw?: string } }[])[0]?.value.raw;
    return raw ?? undefined;
  }
  return undefined;
};

const keyOf = (property: EsNode): string | undefined => {
  if (property.type !== "Property" || property.computed === true) return undefined;
  const key = property.key as EsNode;
  return key.type === "Identifier" ? String(key.name) : typeof key.value === "string" ? key.value : undefined;
};

export const expressionOf = (estree: unknown): EsNode | undefined => {
  const body = (estree as { body?: EsNode[] } | undefined)?.body;
  return body?.length === 1 && body[0]?.type === "ExpressionStatement"
    ? (body[0].expression as EsNode)
    : undefined;
};

type StaticValue = string | number | boolean | null | StaticValue[] | { [key: string]: StaticValue };

export const staticValue = (node: EsNode | undefined, preserveTemplateEscapes = false): StaticValue => {
  const literal =
    node?.type === "TemplateLiteral" &&
    !preserveTemplateEscapes &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
      ? (node.quasis as { value: { cooked?: string } }[])[0]?.value.cooked
      : literalOf(node);
  if (literal !== undefined) return literal;
  if (node?.type === "Literal" && node.value === null) return null;
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "-" &&
    typeof literalOf(node.argument as EsNode) === "number"
  )
    return -Number(literalOf(node.argument as EsNode));
  if (node?.type === "ArrayExpression")
    return (node.elements as EsNode[]).map((element) => staticValue(element));
  if (node?.type === "ObjectExpression") {
    const pairs = (node.properties as EsNode[]).map((property) => {
      const key = keyOf(property);
      if (
        key === undefined ||
        property.kind !== "init" ||
        property.method === true ||
        property.shorthand === true
      )
        throw new SyntaxError("Unsupported static object property");
      return [key, staticValue(property.value as EsNode)] as const;
    });
    if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
      throw new SyntaxError("Duplicate static object property");
    return Object.fromEntries(pairs);
  }
  throw new SyntaxError("Unsupported static expression");
};
