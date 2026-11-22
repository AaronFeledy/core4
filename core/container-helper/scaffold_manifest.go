package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func (s *scaffold) newManifest() *scaffoldManifest {
	stage, err := filepath.Rel(s.appRoot, s.stageDir)
	if err != nil {
		stage = s.stageDir
	}
	return &scaffoldManifest{
		Version: scaffoldManifestVersion,
		Command: s.command,
		Phase:   "staging",
		Stage:   filepath.ToSlash(stage),
		Hooks:   map[string]bool{},
	}
}

func (s *scaffold) stage(manifest *scaffoldManifest, options scaffoldOptions) error {
	if err := os.RemoveAll(s.stageDir); err != nil {
		return err
	}
	manifest.Phase = "staging"
	manifest.Entries = nil
	manifest.Hooks = map[string]bool{}
	manifest.Applied = nil
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	if err := os.MkdirAll(s.stageDir, 0o755); err != nil {
		return err
	}
	s.point("stage-created")
	if err := options.generate(s.stageDir, manifest); err != nil {
		// A generation failure has promoted nothing. A kill does not run
		// cleanup: the staging phase is replayed from scratch on resume.
		s.cleanup()
		return err
	}
	s.point("generated")
	if err := s.classify(manifest, options.requiredOutputs); err != nil {
		s.cleanup()
		return err
	}
	return nil
}

func (s *scaffold) cleanup() {
	_ = os.RemoveAll(s.stageDir)
	_ = os.Remove(s.manifestPath)
	_ = os.Remove(filepath.Join(s.appRoot, scaffoldStageRoot))
	syncDir(s.appRoot)
}

func (s *scaffold) finish(applied []byte) error {
	if err := os.RemoveAll(s.stageDir); err != nil {
		return err
	}
	s.point("stage-removed")
	_ = os.Remove(filepath.Join(s.appRoot, scaffoldStageRoot))
	if s.markerPath != "" {
		if err := writeScaffoldRecord(s.markerPath, applied, 0o644); err != nil {
			return err
		}
		s.point("complete-marker")
	}
	return s.retireManifest()
}

func (s *scaffold) retireManifest() error {
	if err := os.Remove(s.manifestPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	syncDir(s.appRoot)
	s.point("manifest-removed")
	return nil
}

func (s *scaffold) saveManifest(manifest *scaffoldManifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := writeScaffoldRecord(s.manifestPath, append(data, '\n'), 0o600); err != nil {
		return err
	}
	s.point("manifest")
	return nil
}

func writeScaffoldRecord(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Chmod(mode); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Sync(); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

func (s *scaffold) loadManifest() (*scaffoldManifest, bool, error) {
	data, err := readScaffoldRecord(s.manifestPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var manifest scaffoldManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, false, fmt.Errorf("%s scaffold recovery manifest is invalid: %w", s.label, err)
	}
	stage, err := filepath.Rel(s.appRoot, s.stageDir)
	if err != nil {
		stage = s.stageDir
	}
	if manifest.Version != scaffoldManifestVersion ||
		manifest.Command != s.command ||
		manifest.Stage != filepath.ToSlash(stage) {
		return nil, false, fmt.Errorf(
			"%s scaffold recovery manifest does not belong to this app root.",
			s.label,
		)
	}
	switch manifest.Phase {
	case "staging", "staged", "promoted":
	default:
		return nil, false, fmt.Errorf("Invalid %s scaffold manifest phase: %s", s.label, manifest.Phase)
	}
	for _, entry := range manifest.Entries {
		if err := s.validateStagedName(entry.Name); err != nil {
			return nil, false, err
		}
		switch entry.State {
		case "preexisting", "pending", "ready", "complete", "nested-pending", "nested-incomplete", "nested-ready":
		default:
			return nil, false, fmt.Errorf("Invalid %s scaffold manifest state: %s", s.label, entry.State)
		}
	}
	if manifest.Hooks == nil {
		manifest.Hooks = map[string]bool{}
	}
	return &manifest, true, nil
}

func readScaffoldRecord(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("scaffold state %s is not a regular file", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		// Once observed, a vanished record must not be mistaken for absent state.
		return nil, fmt.Errorf("could not read observed scaffold state %s: %v", path, err)
	}
	return data, nil
}

func (s *scaffold) stageRequired(manifest *scaffoldManifest) bool {
	for _, entry := range manifest.Entries {
		switch entry.State {
		case "pending", "ready", "nested-pending":
			return true
		}
	}
	return false
}

func (s *scaffold) validateStagedName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00\n") {
		return fmt.Errorf("Invalid %s scaffold entry: %s", s.label, name)
	}
	if name == scaffoldStageRoot || name == scaffoldLockName || name == filepath.Base(s.manifestPath) ||
		(s.markerPath != "" && name == filepath.Base(s.markerPath)) {
		return fmt.Errorf("Invalid %s scaffold entry: %s is reserved for Lando.", s.label, name)
	}
	return nil
}
