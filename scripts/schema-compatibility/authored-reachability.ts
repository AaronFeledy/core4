import type { SchemaAST } from "effect";

/** Follow codec links, not just the projection used by JSON Schema. */
export const authoredDependencies = (root: SchemaAST.AST, name: string): readonly string[] => {
  const seen = new Set<SchemaAST.AST>();
  const findings: string[] = [];
  const mark = (annotations: SchemaAST.AST["annotations"], path: string) => {
    const marker = annotations?.landoAuthoredInput;
    if (typeof marker === "string") findings.push(`${path}: ${marker}`);
  };
  const checks = (items: SchemaAST.Checks | undefined, path: string) => {
    for (const check of items ?? []) {
      mark(check.annotations, path);
      if (check._tag === "FilterGroup") checks(check.checks, path);
    }
  };
  const visit = (ast: SchemaAST.AST, path: string) => {
    if (seen.has(ast)) return;
    seen.add(ast);
    mark(ast.annotations, path);
    checks(ast.checks, path);
    if ("encodingChecks" in ast) checks(ast.encodingChecks, path);
    for (const link of ast.encoding ?? []) visit(link.to, path);
    switch (ast._tag) {
      case "Objects":
        for (const prop of ast.propertySignatures) visit(prop.type, `${path}.${String(prop.name)}`);
        for (const index of ast.indexSignatures) {
          visit(index.parameter, `${path}{key}`);
          visit(index.type, `${path}.*`);
        }
        break;
      case "Arrays":
        for (const item of [...ast.elements, ...ast.rest]) visit(item, `${path}[]`);
        break;
      case "Union":
        for (const member of ast.types) visit(member, path);
        break;
      case "Suspend":
        visit(ast.thunk(), path);
        break;
      case "Declaration":
        for (const parameter of ast.typeParameters) visit(parameter, path);
        break;
      case "TemplateLiteral":
        for (const part of ast.parts) visit(part, path);
        break;
    }
  };
  visit(root, name);
  return findings;
};
