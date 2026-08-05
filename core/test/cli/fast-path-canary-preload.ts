const CANARY_MODULES: ReadonlyArray<{ readonly marker: string; readonly filter: RegExp }> = [
  { marker: "effect", filter: /node_modules[\\/]effect[\\/]dist[\\/].*\.js$/ },
  { marker: "@oclif/core", filter: /node_modules[\\/]@oclif[\\/].*\.js$/ },
];

Bun.plugin({
  name: "fast-path-import-canary",
  setup(build) {
    for (const { marker, filter } of CANARY_MODULES) {
      build.onLoad({ filter }, (args) => {
        throw new Error(`[FAST_PATH_CANARY] ${marker} was imported on the fast path: ${args.path}`);
      });
    }
  },
});
