package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const drupalScaffoldOutputs = "composer.json, web/, vendor/bin/drush, vendor/bin/phpcs, vendor/bin/phpcbf, vendor/bin/phpstan, phpcs.xml.dist, and phpstan.neon.dist"

var drupalLintPackages = [...]string{
	"drupal/coder",
	"phpstan/phpstan",
	"mglaman/phpstan-drupal",
	"phpstan/extension-installer",
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

func (s *scaffold) stageDrupalLintFiles(stage string) error {
	for _, binary := range []string{"drush", "phpcs", "phpcbf", "phpstan"} {
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
			_, writeErr := file.WriteString(config.content)
			err = errors.Join(writeErr, file.Close())
		}
		if err != nil {
			return fmt.Errorf("%s scaffold could not write %s: %w", s.label, config.name, err)
		}
	}
	return nil
}
