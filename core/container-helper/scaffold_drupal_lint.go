package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func (i drupalSiteIntent) outputs() string {
	return "composer.json, composer.lock, " + i.Webroot + "/index.php, " + i.Webroot + "/core, and vendor/bin/drush"
}

const drupalPHPCSConfig = `<?xml version="1.0" encoding="UTF-8"?>
<ruleset name="drupal-project">
  <description>Drupal coding standards for custom code.</description>
  <rule ref="Drupal"/>
  <rule ref="DrupalPractice"/>
  <arg name="extensions" value="engine,inc,info,install,module,php,profile,test,theme,yml"/>
  <exclude-pattern>*/contrib/*</exclude-pattern>
  <exclude-pattern>*/node_modules/*</exclude-pattern>
  <exclude-pattern>*/vendor/*</exclude-pattern>
  <file>web/modules</file>
  <file>web/themes</file>
  <file>web/profiles</file>
</ruleset>
`

const drupalPHPStanConfig = `parameters:
  level: 1
  paths:
    - web/modules
    - web/themes
    - web/profiles
  excludePaths:
    - '*/contrib/*'
    - '*/node_modules/*'
`

func (i drupalSiteIntent) devArgs(stage, core string) []string {
	args := []string{"--working-dir=" + stage, "require", "--dev", "--no-update"}
	args = append(args, "drupal/coder:^8.3 || ^9.0", "phpstan/phpstan:^1.12 || ^2.0", "mglaman/phpstan-drupal:^1.2 || ^2.0", "phpstan/extension-installer:^1.4")
	if i.Testing { args = append(args,"drupal/core-dev:"+core) }
	return args
}

func (s *scaffold) stageDrupalSiteFiles(stage string, intent drupalSiteIntent) error {
	if !intent.complete(stage) { return fmt.Errorf("%s did not stage %s",s.label,intent.outputs()) }
	binaries := []string{"phpcs", "phpcbf", "phpstan"}
	if intent.Testing { binaries = append(binaries,"phpunit") }
	for _, binary := range binaries {
		path := filepath.Join("vendor", "bin", binary)
		if !executableFile(filepath.Join(stage, path)) {
			return fmt.Errorf("%s scaffold did not stage %s.", s.label, path)
		}
	}
	for _, config := range []struct{ name, content string }{
		{"phpcs.xml.dist", drupalPHPCSConfig},
		{"phpstan.neon.dist", drupalPHPStanConfig},
	} {
		path := filepath.Join(stage, config.name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, fs.ErrExist) {
			if !isRegularFile(path) {
				return fmt.Errorf("%s scaffold did not stage %s.", s.label, config.name)
			}
			continue
		}
		if err == nil {
			_, writeErr := file.WriteString(strings.ReplaceAll(config.content,"web/",intent.Webroot+"/"))
			err = errors.Join(writeErr, file.Close())
		}
		if err != nil {
			return fmt.Errorf("%s scaffold could not write %s: %w", s.label, config.name, err)
		}
	}
	return nil
}
