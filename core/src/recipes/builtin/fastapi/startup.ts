export const FASTAPI_ENTRYPOINT = [
  "sh",
  "-c",
  '([ -x /app/.venv/bin/pip ] || /usr/local/bin/python -m venv /app/.venv) && exec "$@"',
  "--",
] as const;

export const FASTAPI_ENVIRONMENT = {
  VIRTUAL_ENV: "/app/.venv",
  PATH: "/app/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
} as const;
