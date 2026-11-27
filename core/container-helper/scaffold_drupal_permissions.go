package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func (s *scaffold) prepareDrupalTestDirs(webroot string) error {
	sites := filepath.Join(s.appRoot, webroot, "sites")
	for _, subdir := range []string{"simpletest", "simpletest/browser_output", "default/files", "default/files/simpletest"} {
		path := filepath.Join(sites, subdir)
		for component := path; component != s.appRoot; component = filepath.Dir(component) {
			info, err := os.Lstat(component)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fmt.Errorf("Drupal test path %s is not a real directory", component)
			}
		}
		if err := os.MkdirAll(path, 0o755); err != nil {
			return err
		}
		if os.Geteuid() != 0 {
			if err := s.runCommand(s.appRoot, "sh", "-ec", `test "$(id -u)" = "$(id -u www-data)" && test -w "$1"`, "lando-drupal-test-access", path); err != nil {
				return fmt.Errorf("Drupal test worker cannot write %s: %w", path, err)
			}
			continue
		}
		if err := s.runCommand(s.appRoot, "chown", "-h", "--", "www-data", path); err != nil {
			return fmt.Errorf("could not give the Drupal test worker access to %s: %w", path, err)
		}
		if err := s.runCommand(s.appRoot, "runuser", "-u", "www-data", "--", "test", "-w", path); err != nil {
			return fmt.Errorf("Drupal test worker cannot write %s: %w", path, err)
		}
	}
	return nil
}
