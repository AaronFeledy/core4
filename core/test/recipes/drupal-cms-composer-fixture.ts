/** Offline Composer boundary model; the scaffold's real PHP integrity checks still execute. */
export const fakeCmsComposer = String.raw`#!/usr/bin/env php
<?php
$args = array_slice($argv, 1);
$target = null;
if (str_starts_with($args[0], '--working-dir=')) {
    $target = substr(array_shift($args), strlen('--working-dir='));
}
$command = array_shift($args);
$mode = getenv('LANDO_TEST_COMPOSER_MODE') ?: 'secure';
$positional = array_values(array_filter($args, fn($arg) => !str_starts_with($arg, '--')));
file_put_contents(getenv('LANDO_TEST_COMPOSER_LOG'), trim($command . ' ' . ($command === 'run-script' ? $positional[0] : '')) . "\n", FILE_APPEND);
$read = fn($file) => json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
$write = fn($file, $value) => file_put_contents($file, json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
switch ($command) {
case 'create-project':
    $target = $positional[1];
    if (!in_array('--no-install', $args, true) || !in_array('--no-scripts', $args, true)) exit(2);
    mkdir($target . '/web/core/lib', 0777, true);
    $write($target . '/composer.json', ['require' => ['drupal/cms' => '^2.0', 'drupal/drupal_cms_starter' => '^2'], 'repositories' => ['drupal' => ['type' => 'composer', 'url' => 'https://packages.drupal.org/8']], 'scripts' => ['post-update-cmd' => 'rm -f vendor/bin/composer']]);
    file_put_contents($target . '/web/early.txt', "early\n");
    file_put_contents($target . '/web/core/lib/Drupal.php', "late\n");
    if ($legacyLog = getenv('COMPOSER_LOG')) {
        file_put_contents($legacyLog, $target . "\n", FILE_APPEND);
        file_put_contents($target . '/existing.txt', "staged\n");
        if (getenv('CLASSIFICATION_FIXTURES') === '1') {
            file_put_contents($target . '/zero.txt', '');
            file_put_contents($target . '/broken.txt', "staged\n");
            foreach (['existing-dir', 'newline-dir'] as $directory) {
                mkdir($target . '/' . $directory);
                file_put_contents($target . '/' . $directory . '/staged.txt', "staged\n");
            }
        }
    }
    exit(0);
case 'config':
    if ($positional[0] !== 'repositories.lando-svg-image') exit(2);
    $root = $read($target . '/composer.json');
    $repository = json_decode($positional[1], true, 512, JSON_THROW_ON_ERROR);
    if ($mode === 'repo-tamper') $repository['package']['description'] = 'tampered';
    $root['repositories'] = ['lando-svg-image' => $repository] + $root['repositories'];
    $write($target . '/composer.json', $root);
    exit(0);
case 'require':
    if (!in_array('--no-update', $args, true)) exit(2);
    $root = $read($target . '/composer.json');
    foreach ($positional as $requirement) {
        [$name, $constraint] = explode(':', $requirement, 2);
        $root['require'][$name] = $constraint;
    }
    $write($target . '/composer.json', $root);
    exit(0);
case 'update':
    foreach (['--no-install', '--no-scripts', '--no-plugins'] as $flag) if (!in_array($flag, $args, true)) exit(2);
    if ($mode === 'resolve-fail') exit(6);
    $root = $read($target . '/composer.json');
    $repository = reset($root['repositories']);
    if (($repository['type'] ?? null) !== 'package' || $root['require']['drupal/svg_image'] !== $repository['package']['version']) exit(3);
    $package = $repository['package'];
    unset($package['minimum-stability']);
    $package['license'] = (array) $package['license'];
    $aliases = [];
    switch ($mode) {
    case 'lock-ref': $package['source']['reference'] = str_repeat('a', 40); break;
    case 'lock-url': $package['source']['url'] = 'https://example.test/evil.git'; break;
    case 'lock-type': $package['type'] = 'composer-plugin'; break;
    case 'lock-license': $package['license'] = ['MIT']; break;
    case 'lock-version': $package['version'] = '3.2.4'; break;
    case 'lock-alias': $aliases[] = ['package' => 'drupal/svg_image', 'version' => '3.x-dev', 'alias' => '3.2.4']; break;
    case 'lock-require': $package['require']['enshrined/svg-sanitize'] = '^0.22'; break;
    case 'lock-autoload': $package['autoload'] = ['files' => ['evil.php']]; break;
    case 'lock-extra': $package['extra'] = ['installer-name' => 'evil']; break;
    }
    $write($target . '/composer.lock', ['packages' => [$package, ['name' => 'enshrined/svg-sanitize', 'version' => '1.0.0']], 'aliases' => $aliases]);
    exit(0);
case 'audit':
    if (!in_array('--locked', $args, true)) exit(2);
    exit($mode === 'audit-fail' ? 7 : 0);
case 'install':
    if ($mode === 'install-fail') exit(8);
    $root = $read($target . '/composer.json');
    $source = $read($target . '/composer.lock')['packages'][0]['source'];
    mkdir($target . '/vendor/bin', 0777, true);
    mkdir($target . '/vendor/composer', 0777, true);
    foreach (['drush', 'composer'] as $binary) {
        file_put_contents($target . '/vendor/bin/' . $binary, "#!/bin/sh\n");
        chmod($target . '/vendor/bin/' . $binary, 0755);
    }
    if ($mode === 'installed-source') $source['reference'] = str_repeat('b', 40);
    $write($target . '/vendor/composer/installed.json', ['packages' => [['name' => 'drupal/svg_image', 'source' => $source, 'installation-source' => 'source']]]);
    $metadata = reset($root['repositories'])['package'];
    unset($metadata['version'], $metadata['source']);
    if ($mode === 'installed-require') $metadata['require']['enshrined/svg-sanitize'] = '^0.22';
    if ($mode === 'installed-extra') $metadata['extra'] = ['installer-name' => 'evil'];
    mkdir($target . '/web/modules/contrib/svg_image/.git', 0777, true);
    $write($target . '/web/modules/contrib/svg_image/composer.json', $metadata);
    exit(0);
case 'run-script':
    $root = $read($target . '/composer.json');
    switch ($positional[0]) {
    case 'post-update-cmd':
        foreach ((array) $root['scripts']['post-update-cmd'] as $script) passthru('cd ' . escapeshellarg($target) . ' && ' . $script, $status);
        exit($status ?? 0);
    case 'post-create-project-cmd':
        $pin = $root['require']['drupal/svg_image'];
        if (str_contains($pin, ' as ') || str_contains($pin, '#')) {
            fwrite(STDERR, "recipe unpack cannot minimize ^3.1 with $pin\n");
            exit(9);
        }
        unset($root['require']['drupal/drupal_cms_starter']);
        $root['require'] += ['drupal/svg_image' => '^3.1', 'drupal/gin' => '^5'];
        if ($mode === 'hook-rewrite') $root['require']['drupal/svg_image'] = '^3.1';
        $write($target . '/composer.json', $root);
        exit(0);
    }
    exit(2);
default: exit(2);
}
`;

export const fakeCmsGit = `#!/bin/sh
set -eu
test "$1" = -C || exit 2
case "$3" in
  rev-parse)
    if test "\${LANDO_TEST_COMPOSER_MODE:-}" = installed-ref; then
      printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    else
      printf '%s\\n' c788b1e2f2be29f62c9812b2b0558472afa61d6d
    fi;;
  status)
    if test "\${LANDO_TEST_COMPOSER_MODE:-}" = installed-dirty; then printf ' M svg_image.module\\n'; fi;;
  *) exit 2;;
esac
`;
