package main

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type cmsVerifierFixture struct {
	root      string
	repo      string
	rootJSON  map[string]any
	lock      map[string]any
	installed map[string]any
	checkout  map[string]any
}

func newCmsVerifierFixture(t *testing.T) *cmsVerifierFixture {
	t.Helper()
	repository := cmsSvgRepositoryJSON()
	expected := readFakeJSONBytes([]byte(repository))
	pkg := maps.Clone(expected["package"].(map[string]any))
	upstream := maps.Clone(pkg)
	delete(upstream, "version")
	delete(upstream, "source")

	locked := maps.Clone(pkg)
	locked["license"] = []any{"GPL-2.0-or-later"}

	fixture := &cmsVerifierFixture{
		root: t.TempDir(),
		repo: repository,
		rootJSON: map[string]any{
			"require": map[string]any{
				"drupal/svg_image":          "3.x-dev",
				"enshrined/svg-sanitize":    "^1.0",
				"drupal/drupal_cms_starter": "^2",
			},
			"repositories": map[string]any{"lando-svg-image": expected},
		},
		lock: map[string]any{
			"packages": []any{locked, map[string]any{"name": "enshrined/svg-sanitize", "version": "1.0.0"}},
			"aliases":  []any{},
		},
		installed: map[string]any{"packages": []any{map[string]any{
			"name":                "drupal/svg_image",
			"source":              maps.Clone(pkg["source"].(map[string]any)),
			"installation-source": "source",
		}}},
		checkout: upstream,
	}
	fixture.write(t)
	return fixture
}

func (f *cmsVerifierFixture) write(t *testing.T) {
	t.Helper()
	writeFakeJSON(filepath.Join(f.root, "composer.json"), f.rootJSON)
	writeFakeJSON(filepath.Join(f.root, "composer.lock"), f.lock)
	writeFakeJSON(filepath.Join(f.root, "vendor", "composer", "installed.json"), f.installed)
	writeFakeJSON(filepath.Join(f.root, "web", "modules", "contrib", "svg_image", "composer.json"), f.checkout)
}

func TestCmsProjectionAcceptsTheReviewedProjection(t *testing.T) {
	fixture := newCmsVerifierFixture(t)
	if err := verifyCmsProjection(fixture.root, "locked", fixture.repo); err != nil {
		t.Fatalf("locked projection rejected: %v", err)
	}
	if err := verifyCmsProjection(fixture.root, "installed", fixture.repo); err != nil {
		t.Fatalf("installed projection rejected: %v", err)
	}
}

func TestCmsProjectionRejectsEveryTamper(t *testing.T) {
	cases := map[string]func(*cmsVerifierFixture){
		"root requirement": func(f *cmsVerifierFixture) {
			f.rootJSON["require"].(map[string]any)["drupal/svg_image"] = "^3.1"
		},
		"repository projection": func(f *cmsVerifierFixture) {
			repository := f.rootJSON["repositories"].(map[string]any)["lando-svg-image"].(map[string]any)
			repository["package"].(map[string]any)["description"] = "tampered"
		},
		"lock reference": func(f *cmsVerifierFixture) {
			locked := f.lock["packages"].([]any)[0].(map[string]any)
			locked["source"].(map[string]any)["reference"] = strings.Repeat("a", 40)
		},
		"lock url": func(f *cmsVerifierFixture) {
			locked := f.lock["packages"].([]any)[0].(map[string]any)
			locked["source"].(map[string]any)["url"] = "https://example.test/evil.git"
		},
		"lock type": func(f *cmsVerifierFixture) {
			f.lock["packages"].([]any)[0].(map[string]any)["type"] = "composer-plugin"
		},
		"lock license": func(f *cmsVerifierFixture) {
			f.lock["packages"].([]any)[0].(map[string]any)["license"] = []any{"MIT"}
		},
		"lock version": func(f *cmsVerifierFixture) {
			f.lock["packages"].([]any)[0].(map[string]any)["version"] = "3.2.4"
		},
		"lock alias": func(f *cmsVerifierFixture) {
			f.lock["aliases"] = []any{map[string]any{"package": "drupal/svg_image", "version": "3.x-dev", "alias": "3.2.4"}}
		},
		"lock require": func(f *cmsVerifierFixture) {
			locked := f.lock["packages"].([]any)[0].(map[string]any)
			locked["require"].(map[string]any)["enshrined/svg-sanitize"] = "^0.22"
		},
		"lock autoload": func(f *cmsVerifierFixture) {
			f.lock["packages"].([]any)[0].(map[string]any)["autoload"] = map[string]any{"files": []any{"evil.php"}}
		},
		"lock extra": func(f *cmsVerifierFixture) {
			f.lock["packages"].([]any)[0].(map[string]any)["extra"] = map[string]any{"installer-name": "evil"}
		},
		"installed reference": func(f *cmsVerifierFixture) {
			record := f.installed["packages"].([]any)[0].(map[string]any)
			record["source"].(map[string]any)["reference"] = strings.Repeat("b", 40)
		},
		"installed source": func(f *cmsVerifierFixture) {
			record := f.installed["packages"].([]any)[0].(map[string]any)
			record["installation-source"] = "dist"
		},
		"installed metadata": func(f *cmsVerifierFixture) {
			f.checkout["require"].(map[string]any)["enshrined/svg-sanitize"] = "^0.22"
		},
		"installed extra": func(f *cmsVerifierFixture) {
			f.checkout["extra"] = map[string]any{"installer-name": "evil"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			fixture := newCmsVerifierFixture(t)
			mutate(fixture)
			fixture.write(t)
			phase := "installed"
			if name != "installed reference" && name != "installed source" && name != "installed metadata" && name != "installed extra" {
				phase = "locked"
			}
			err := verifyCmsProjection(fixture.root, phase, fixture.repo)
			if err == nil {
				t.Fatalf("%s was accepted", name)
			}
			if !strings.Contains(err.Error(), "drupal/svg_image") {
				t.Fatalf("error does not name the package: %v", err)
			}
		})
	}
}

func TestCmsProjectionAcceptsComposerRepositoryList(t *testing.T) {
	fixture := newCmsVerifierFixture(t)
	requireJSON, err := json.Marshal(fixture.rootJSON["require"])
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"require":` + string(requireJSON) +
		`,"repositories":[{"name":"lando-svg-image",` + fixture.repo[1:] + `]}`)
	if err := os.WriteFile(filepath.Join(fixture.root, "composer.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyCmsProjection(fixture.root, "locked", fixture.repo); err != nil {
		t.Fatalf("Composer repository list rejected: %v", err)
	}
}

func TestCmsProjectionRejectsALaterRepositoryFirst(t *testing.T) {
	fixture := newCmsVerifierFixture(t)
	requireJSON, err := json.Marshal(fixture.rootJSON["require"])
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"require":` + string(requireJSON) +
		`,"repositories":{"other":{"type":"composer","url":"https://example.test"},"lando-svg-image":` +
		fixture.repo + `}}`)
	if err := os.WriteFile(filepath.Join(fixture.root, "composer.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	err = verifyCmsProjection(fixture.root, "locked", fixture.repo)
	if err == nil {
		t.Fatal("a later repository was accepted")
	}
	if !strings.Contains(err.Error(), "repository is not first") {
		t.Fatalf("unexpected error: %v", err)
	}
}
