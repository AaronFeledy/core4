<?php
// Hidden-step helper for docs/guides/services/adminer.mdx. Not part of the Landofile.
if ($argc < 8) {
  fwrite(STDERR, "usage: base driver server user pass db needle [table]\n");
  exit(2);
}
$base = rtrim($argv[1], "/") . "/";
$driver = $argv[2];
$server = $argv[3];
$user = $argv[4];
$pass = $argv[5];
$db = $argv[6];
$needle = $argv[7];
$table = $argv[8] ?? "notes";
$cookie = sys_get_temp_dir() . "/ac-" . getmypid();
@unlink($cookie);

function H($method, $url, $cookie, $body = null) {
  $hf = tempnam(sys_get_temp_dir(), "h");
  $of = tempnam(sys_get_temp_dir(), "o");
  $cmd = ["curl", "-sS", "-c", $cookie, "-b", $cookie, "-D", $hf, "-o", $of, "--max-time", "20"];
  if ($method === "POST") {
    array_push($cmd, "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data", $body ?? "");
  }
  $cmd[] = $url;
  $p = proc_open($cmd, [2 => ["pipe", "w"]], $pipes);
  $err = stream_get_contents($pipes[2]);
  fclose($pipes[2]);
  $st = proc_close($p);
  $hdr = (string) file_get_contents($hf);
  $out = (string) file_get_contents($of);
  @unlink($hf);
  @unlink($of);
  if ($st !== 0) {
    fwrite(STDERR, "curl failed ($st): $err\n");
    exit(1);
  }
  return [$hdr, $out];
}

function T($html) {
  return trim(html_entity_decode(preg_replace("/[ \\t\\n\\r]+/", " ", strip_tags($html)) ?? $html, ENT_QUOTES | ENT_HTML5));
}

function resolve_url($base, $loc) {
  $loc = trim($loc);
  return str_starts_with($loc, "http") ? $loc : $base . ltrim($loc, "/");
}

function G($url, $cookie, $base) {
  $hdr = "";
  $body = "";
  for ($i = 0; $i < 6; $i++) {
    [$hdr, $body] = H("GET", $url, $cookie);
    if (preg_match("/^HTTP\\/[0-9.]+ 302\\b/mi", $hdr) && preg_match("/^Location:\\s*(.+)$/mi", $hdr, $loc)) {
      $url = resolve_url($base, $loc[1]);
      continue;
    }
    return [$hdr, $body];
  }
  return [$hdr, $body];
}

[$_, $login] = G($base, $cookie, $base);
if (!preg_match("/name=.token. value=.([^\\s>]+)/", $login, $m)) {
  echo T($login) . "\n";
  fwrite(STDERR, "no login token\n");
  exit(1);
}
$token = trim($m[1], "'\"");
$post = http_build_query([
  "auth[driver]" => $driver,
  "auth[server]" => $server,
  "auth[username]" => $user,
  "auth[password]" => $pass,
  "auth[db]" => $db,
  "token" => $token,
]);
[$hdr, $body] = H("POST", $base, $cookie, $post);
$next = preg_match("/^Location:\\s*(.+)$/mi", $hdr, $loc) ? resolve_url($base, $loc[1]) : $base;
[$_, $page] = G($next, $cookie, $base);
$pages = [$page];
$urls = [];
if (preg_match_all("/href=.([^ >]*select[^ >]*)/", $page, $hs)) {
  foreach ($hs[1] as $h) {
    $urls[] = resolve_url($base, html_entity_decode(trim($h, "\"'"), ENT_QUOTES | ENT_HTML5));
  }
}
foreach ([
  http_build_query([$driver => $server, "username" => $user, "db" => $db, "select" => $table], "", "&", PHP_QUERY_RFC3986),
  http_build_query([$driver => $server, "username" => $user, "db" => $db, "ns" => "public", "select" => $table], "", "&", PHP_QUERY_RFC3986),
] as $q) {
  $urls[] = $base . "?" . $q;
}
foreach (array_unique($urls) as $u) {
  [$_, $p] = G($u, $cookie, $base);
  $pages[] = $p;
}
@unlink($cookie);
foreach ($pages as $p) {
  if (str_contains($p, $needle)) {
    echo "BROWSE_OK $needle\n";
    exit(0);
  }
}
echo T(implode("\n", $pages)) . "\n";
exit(1);
