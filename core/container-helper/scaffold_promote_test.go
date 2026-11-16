package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRenameNoReplaceRefusesExistingPaths(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	if err := os.WriteFile(source, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(source, target); !errors.Is(err, syscall.EEXIST) {
		t.Fatalf("file rename returned %v, want EEXIST", err)
	}
	assertFileText(t, target, "old\n")
	assertFileText(t, source, "new\n")

	sourceDir := filepath.Join(root, "source-dir")
	targetDir := filepath.Join(root, "target-dir")
	if err := os.Mkdir(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(targetDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(sourceDir, targetDir); !errors.Is(err, syscall.EEXIST) {
		t.Fatalf("directory rename returned %v, want EEXIST", err)
	}
	if !pathExists(sourceDir) || !pathExists(targetDir) {
		t.Fatal("a refused directory rename moved the source")
	}
}

func TestCreateProjectResumesNestedFillAfterKill(t *testing.T) {
	for _, point := range []string{"nested-state", "nested-partial", "nested-copied", "nested-ready", "nested-child", "nested-complete"} {
		t.Run(point, func(t *testing.T) {
			fixture := newScaffoldFixture(t, nil)
			if err := os.MkdirAll(filepath.Join(fixture.appRoot, "public"), 0o755); err != nil {
				t.Fatal(err)
			}
			fixture.kill(t, "create-project", point, "acme/nested")

			if code := fixture.run(t, "create-project", "acme/nested"); code != 0 {
				t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
			}
			assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "first\n")
			if pathExists(filepath.Join(fixture.appRoot, "public", ".lando-partial")) {
				t.Fatal("nested partial survived the resume")
			}
			fixture.assertNoScaffoldState(t)
		})
	}
}

func TestCreateProjectRefusesATargetThatAppearedAfterTheSnapshot(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	fixture.kill(t, "create-project", "sibling-ready", "acme/race")
	if err := os.WriteFile(filepath.Join(fixture.appRoot, "app"), []byte("foreign\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "create-project", "acme/race"); code == 0 {
		t.Fatal("promotion overwrote a path created after the manifest snapshot")
	}
	if !strings.Contains(fixture.stderr.String(), "ambiguous target") {
		t.Fatalf("unexpected error: %s", fixture.stderr.String())
	}
	assertFileText(t, filepath.Join(fixture.appRoot, "app"), "foreign\n")
}

func TestCreateProjectRefusesANestedTargetThatAppearedAfterTheSnapshot(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	if err := os.MkdirAll(filepath.Join(fixture.appRoot, "public"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixture.kill(t, "create-project", "nested-ready", "acme/nested-race")
	if err := os.WriteFile(filepath.Join(fixture.appRoot, "public", "index.php"), []byte("foreign\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "create-project", "acme/nested-race"); code == 0 {
		t.Fatal("nested promotion overwrote a path created after the manifest snapshot")
	}
	if !strings.Contains(fixture.stderr.String(), "ambiguous target") {
		t.Fatalf("unexpected error: %s", fixture.stderr.String())
	}
	assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "foreign\n")
}

func TestCreateProjectPreservesPreexistingOccupiedTargets(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	occupied := filepath.Join(fixture.appRoot, "composer.json")
	if err := os.WriteFile(occupied, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The preflight only refuses an existing composer.json without a manifest;
	// give it the create-project manifest so classification sees the file.
	manifest := &scaffoldManifest{
		Version: scaffoldManifestVersion,
		Command: "create-project",
		Phase:   "promoted",
		Stage:   ".lando-scaffold/create-project",
		Entries: []scaffoldEntry{{Name: "composer.json", State: "preexisting"}},
		Hooks:   map[string]bool{},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.appRoot, ".lando-create-project-manifest"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "create-project", "acme/occupied"); code != 0 {
		t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
	}
	assertFileText(t, occupied, "{}\n")
}
