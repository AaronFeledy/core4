import { diffComposeSchemaKeyPaths, formatComposeSchemaDiffMarkdown } from "./compose-schema.ts";

export const renderComposeSchemaDiffReport = (oldSchema: unknown, newSchema: unknown): string =>
  formatComposeSchemaDiffMarkdown(diffComposeSchemaKeyPaths(oldSchema, newSchema));

if (import.meta.main) {
  const [oldPath, newPath] = Bun.argv.slice(2);
  if (oldPath === undefined || newPath === undefined) {
    process.stderr.write("usage: report-compose-schema-diff.ts <old-schema.json> <new-schema.json>\n");
    process.exit(2);
  }

  const [oldSchema, newSchema] = await Promise.all([
    Bun.file(oldPath).json() as Promise<unknown>,
    Bun.file(newPath).json() as Promise<unknown>,
  ]);
  process.stdout.write(renderComposeSchemaDiffReport(oldSchema, newSchema));
}
