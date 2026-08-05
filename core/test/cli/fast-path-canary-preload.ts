const CANARY_MODULES = [
  { marker: "effect", filter: /node_modules[\\/]effect[\\/]dist[\\/].*\.js$/ },
  { marker: "@oclif/core", filter: /node_modules[\\/]@oclif[\\/].*\.js$/ },
  { marker: "@lando/sdk", filter: /[\\/]sdk[\\/]src[\\/].*\.ts$/ },
  {
    marker: "renderers",
    filter: /[\\/](?:plugins[\\/]renderer-lando|node_modules[\\/]@lando[\\/]renderer-lando)[\\/].*\.ts$/,
  },
  {
    marker: "plugins",
    filter:
      /[\\/](?:plugins[\\/](?!renderer-lando[\\/])|node_modules[\\/]@lando[\\/](?!sdk[\\/]|renderer-lando[\\/]|core[\\/]|paths[\\/]|state-store[\\/]|container-runtime[\\/])).*\.ts$/,
  },
] as const satisfies readonly { readonly marker: string; readonly filter: RegExp }[];

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
