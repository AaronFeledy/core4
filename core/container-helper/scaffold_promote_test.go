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

func TestCreateProjectResumesNestedPublicationAfterKill(t *testing.T) {
	for _, point := range []string{"nested-temp", "nested-temp-owned", "nested-copied", "nested-partial"} {
		t.Run(point, func(t *testing.T) {
			fixture := newScaffoldFixture(t, nil)
			public := filepath.Join(fixture.appRoot, "public")
			if err := os.MkdirAll(public, 0o755); err != nil {
				t.Fatal(err)
			}
			fixture.kill(t, "create-project", point, "acme/publication")
			assertNestedPublicationState(t, public, point)

			if code := fixture.run(t, "create-project", "acme/publication"); code != 0 {
				t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
			}
			assertDirectoryNames(t, public, []string{"index.php"})
			assertFileText(t, filepath.Join(public, "index.php"), "first\n")
			fixture.assertNoScaffoldState(t)
		})
	}
}

// assertNestedPublicationState proves the kill left one of the three states
// atomic publication allows: no partial, an unpublished temp the engine
// recognizes, or a fully owned partial. A partial without ownership proof is
// never acceptable because a retry must not reject it.
func assertNestedPublicationState(t *testing.T, target string, point string) {
	t.Helper()
	entries, err := os.ReadDir(target)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	partial := filepath.Join(target, ".lando-partial")
	switch point {
	case "nested-temp":
		if len(names) != 1 || !strings.HasPrefix(names[0], ".lando-partial.") {
			t.Fatalf("%s holds %v, want one unpublished partial", target, names)
		}
		if pathExists(filepath.Join(target, names[0], ".lando-owned")) {
			t.Fatalf("%s carried ownership before it was durable", names[0])
		}
	case "nested-temp-owned", "nested-copied":
		if len(names) != 1 || !strings.HasPrefix(names[0], ".lando-partial.") {
			t.Fatalf("%s holds %v, want one unpublished partial", target, names)
		}
		if !pathExists(filepath.Join(target, names[0], ".lando-owned")) {
			t.Fatalf("unpublished partial %s has no ownership proof", names[0])
		}
		if point == "nested-copied" && !pathExists(filepath.Join(target, names[0], "index.php")) {
			t.Fatalf("unpublished partial %s did not receive the staged tree", names[0])
		}
	case "nested-partial":
		if !pathExists(partial) {
			t.Fatalf("%s holds %v, want the published partial", target, names)
		}
		if !pathExists(filepath.Join(partial, ".lando-owned")) {
			t.Fatal("published partial has no ownership proof")
		}
	default:
		t.Fatalf("unknown kill point %s", point)
	}
}

func TestCreateProjectReportsKeptPreexistingPaths(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_EXTRA": ".lando.yml\nLICENSE\nREADME.md",
	})
	kept := []string{".lando.yml", "LICENSE", "README.md"}
	for _, name := range kept {
		if err := os.WriteFile(filepath.Join(fixture.appRoot, name), []byte("user-owned\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if code := fixture.run(t, "create-project", "acme/kept"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	for _, name := range kept {
		assertFileText(t, filepath.Join(fixture.appRoot, name), "user-owned\n")
	}
	assertFileText(t, filepath.Join(fixture.appRoot, "app", "index.php"), "first\n")
	assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "first\n")

	const prefix = `create-project kept existing path "`
	const suffix = `"; the project's version was not installed.`
	report := strings.TrimSuffix(fixture.stderr.String(), "\n")
	lines := strings.Split(report, "\n")
	reported := make([]string, 0, len(lines))
	for _, line := range lines {
		if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) {
			t.Fatalf("unexpected kept-path report line %q", line)
		}
		reported = append(reported, strings.TrimSuffix(strings.TrimPrefix(line, prefix), suffix))
	}
	mustEqualStrings(t, reported, []string{"LICENSE", "README.md"})
	if strings.Contains(fixture.stderr.String(), ".lando.yml") {
		t.Fatalf("reported a Lando-owned file: %s", fixture.stderr.String())
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
