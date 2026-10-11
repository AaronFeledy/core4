export const HUGO_SCAFFOLD = {
  "hugo.toml": `baseURL = '/'
locale = 'en-us'
title = '{{ app.name }}'
`,
  "archetypes/default.md": `+++
title = '{{ replace .File.ContentBaseName "-" " " | title }}'
date = '{{ .Date }}'
draft = false
+++
`,
  "content/_index.md": `+++
title = 'Welcome'
+++

Your Hugo site is ready. Add a page with \`lando hugo new content posts/hello.md\`.
`,
  "layouts/baseof.html": `<!doctype html>
<html lang="{{ site.Language.Locale }}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ .Title }} | {{ site.Title }}</title>
</head>
<body>
  <header><a href="{{ site.Home.RelPermalink }}">{{ site.Title }}</a></header>
  <main>{{ block "main" . }}{{ end }}</main>
</body>
</html>
`,
  "layouts/home.html": `{{ define "main" }}
<h1>{{ .Title }}</h1>
{{ .Content }}
<ul>
{{ range site.RegularPages }}
  <li><a href="{{ .RelPermalink }}">{{ .Title }}</a></li>
{{ end }}
</ul>
{{ end }}
`,
  "layouts/single.html": `{{ define "main" }}
<article>
  <h1>{{ .Title }}</h1>
  {{ .Content }}
</article>
{{ end }}
`,
  "layouts/list.html": `{{ define "main" }}
<h1>{{ .Title }}</h1>
{{ .Content }}
<ul>
{{ range .Pages }}
  <li><a href="{{ .RelPermalink }}">{{ .Title }}</a></li>
{{ end }}
</ul>
{{ end }}
`,
} as const;
