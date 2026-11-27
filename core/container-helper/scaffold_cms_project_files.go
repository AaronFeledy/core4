package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// Drupal CMS uses root-anchored gitignore rules and inline Markdown code spans for docroot paths.
var cmsIgnoreWebroot = regexp.MustCompile(`(?m)^/web/`)
var cmsAgentCodeSpan = regexp.MustCompile("`[^`\r\n]+`")
var cmsAgentWebroot = regexp.MustCompile("^`web/[^[:space:]`]*`$")

func (i drupalSiteIntent) relocateCmsProjectFiles(stage string) error {
	if i.Webroot == "web" {
		return nil
	}
	ignore := filepath.Join(stage, ".gitignore")
	data, err := os.ReadFile(ignore)
	if err != nil {
		return err
	}
	if err := os.WriteFile(ignore, cmsIgnoreWebroot.ReplaceAllLiteral(data, []byte("/"+i.Webroot+"/")), 0o644); err != nil {
		return err
	}

	agents := filepath.Join(stage, "AGENTS.md")
	data, err = os.ReadFile(agents)
	switch {
	case err == nil:
		updated := cmsAgentCodeSpan.ReplaceAllFunc(data, func(span []byte) []byte {
			if cmsAgentWebroot.Match(span) {
				return append([]byte("`"+i.Webroot+"/"), span[len("`web/"):]...)
			}
			return span
		})
		if err := os.WriteFile(agents, updated, 0o644); err != nil {
			return err
		}
	case !errors.Is(err, fs.ErrNotExist):
		return err
	}
	return os.RemoveAll(filepath.Join(stage, ".ddev"))
}
