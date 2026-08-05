export {};

const specifier = Bun.argv[2];
if (specifier === undefined) throw new Error("usage: fast-path-canary-probe.ts <module-specifier>");

await import(specifier);
