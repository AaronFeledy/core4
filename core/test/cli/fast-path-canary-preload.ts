Bun.plugin({
  name: "effect-import-canary",
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]effect[\\/]dist[\\/].*\.js$/ }, (args) => {
      throw new Error(`[FAST_PATH_CANARY] effect was imported on the fast path: ${args.path}`);
    });
  },
});
