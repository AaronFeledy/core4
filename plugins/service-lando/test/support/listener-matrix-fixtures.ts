import type { LandofileShape } from "@lando/sdk/schema";

type MatrixService = NonNullable<typeof LandofileShape.Encoded.services>[string];

export interface MatrixFixture {
  readonly contract: string;
  readonly service: MatrixService;
  readonly files?: Readonly<Record<string, string>>;
}

const python = (variable: string) => [
  "python",
  "-c",
  `import os; from http.server import HTTPServer, SimpleHTTPRequestHandler; HTTPServer(('0.0.0.0', int(os.environ['${variable}'])), SimpleHTTPRequestHandler).serve_forever()`,
];
const ruby = [
  "ruby",
  "-rsocket",
  "-e",
  'server = TCPServer.new("0.0.0.0", Integer(ENV.fetch("PORT"))); loop { client = server.accept; client.close }',
];

// Versioned types select their reviewed catalog artifacts, not custom-image startup paths.
// Keep one image per family even when exercising multiple listener-contract variants.
export const matrixFixtures: readonly MatrixFixture[] = [
  { contract: "apache", service: { type: "apache", appMount: "/app" } }, // httpd:2.4-alpine; webroot needs the app mount.
  {
    contract: "dotnet",
    service: {
      type: "dotnet:9.0",
      appMount: "/app",
      command: ["dotnet", "run", "--project", "/app/matrix.csproj", "--no-launch-profile"],
    },
    files: {
      "matrix.csproj":
        '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
      "Program.cs":
        "var app = Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(args).Build(); app.Run();",
    },
  }, // mcr.microsoft.com/dotnet/sdk:9.0; Kestrel reads ASPNETCORE_HTTP_PORTS.
  { contract: "elasticsearch", service: { type: "elasticsearch:8" } }, // elasticsearch:8.17.0
  {
    contract: "go",
    service: { type: "go:1.23", appMount: "/app", command: ["go", "run", "/app/matrix.go"] },
    files: {
      "matrix.go": `package main
import ("log"; "net/http"; "os")
func main() { log.Fatal(http.ListenAndServe("0.0.0.0:" + os.Getenv("PORT"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))) }
`,
    },
  }, // golang:1.23
  { contract: "localstack", service: { type: "localstack" } }, // localstack/localstack:4.14.0
  { contract: "mailhog", service: { type: "mailhog" } }, // mailhog/mailhog:v1.0.1
  { contract: "mailpit", service: { type: "mailpit" } }, // axllent/mailpit:v1.30.1
  { contract: "mariadb", service: { type: "mariadb:11.4" } },
  { contract: "meilisearch", service: { type: "meilisearch:1" } }, // getmeili/meilisearch:v1.11
  { contract: "memcached", service: { type: "memcached" } }, // memcached:1.6
  {
    contract: "minio",
    service: {
      type: "minio",
      environment: { MINIO_ROOT_USER: "matrixroot", MINIO_ROOT_PASSWORD: "matrixpassword123" },
    },
  }, // Explicit test-only BYO image is supplied at collection, never a product default.
  { contract: "mongodb", service: { type: "mongodb:7" } },
  { contract: "mssql", service: { type: "mssql:2022" } },
  { contract: "mysql", service: { type: "mysql:8.0" } },
  { contract: "nginx", service: { type: "nginx", appMount: "/app" } }, // nginx:1.26-alpine
  {
    contract: "node",
    service: {
      type: "node:24",
      command: [
        "node",
        "-e",
        'require("http").createServer((req,res) => res.end("matrix")).listen(Number(process.env.PORT), "0.0.0.0")',
      ],
    },
  },
  { contract: "opensearch", service: { type: "opensearch:2" } },
  { contract: "php", service: { type: "php:8.4", appMount: "/app" } }, // php:8.4-apache-bookworm
  { contract: "php/fpm", service: { type: "php:8.4", via: "fpm", appMount: "/app" } },
  { contract: "phpmyadmin", service: { type: "phpmyadmin:5" } },
  { contract: "postgres", service: { type: "postgres:16" } },
  { contract: "python", service: { type: "python:3.12", command: python("PORT") } },
  {
    contract: "python/django",
    service: { type: "python:3.12", framework: "django", command: python("PORT") },
  },
  {
    contract: "python/fastapi",
    service: { type: "python:3.12", framework: "fastapi", command: python("UVICORN_PORT") },
  },
  {
    contract: "python/flask",
    service: { type: "python:3.12", framework: "flask", command: python("FLASK_RUN_PORT") },
  },
  { contract: "rabbitmq", service: { type: "rabbitmq:4" } }, // rabbitmq:4-management
  { contract: "redis", service: { type: "redis:7" } },
  { contract: "ruby", service: { type: "ruby:3.3", command: ruby } },
  { contract: "ruby/rails", service: { type: "ruby:3.3", framework: "rails", command: ruby } },
  { contract: "solr", service: { type: "solr:9" } },
  { contract: "static", service: { type: "static", appMount: "/app" } }, // nginx:1.26-alpine
  { contract: "static/caddy", service: { type: "static:caddy", appMount: "/app" } },
  { contract: "tomcat", service: { type: "tomcat:11", appMount: "/app" } }, // Catalog's digest-pinned jre21 artifact.
  { contract: "valkey", service: { type: "valkey" } }, // valkey/valkey:8
  { contract: "varnish", service: { type: "varnish:7", backend: "backend" } },
];
