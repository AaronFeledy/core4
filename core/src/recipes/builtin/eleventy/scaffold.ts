export const ELEVENTY_PACKAGE_JSON_TEMPLATE = `${JSON.stringify(
  {
    name: "{{ app.name }}",
    private: true,
    scripts: {
      start: "eleventy --serve --port 8080",
      build: "eleventy",
    },
    devDependencies: {
      "@11ty/eleventy": "^3.1.2",
    },
  },
  null,
  2,
)}\n`;
