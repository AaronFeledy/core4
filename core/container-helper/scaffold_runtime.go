package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// outputCommand runs a query command and returns its stdout; stderr still
// reaches the caller so a failure keeps its own diagnosis.
func (s *scaffold) outputCommand(dir string, name string, args ...string) (string, error) {
	binary, err := lookPathIn(s.streams.env, name)
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	command := exec.Command(binary, args...)
	command.Dir = dir
	command.Stdin = s.streams.stdin
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = s.streams.stderr
	command.Env = environSlice(s.streams.env)
	err = command.Run()
	return stdout.String(), err
}

func (s *scaffold) runCommand(dir string, name string, args ...string) error {
	return s.streams.runCommand(dir, name, args...)
}

func (streams helperIO) runCommand(dir string, name string, args ...string) error {
	binary, err := lookPathIn(streams.env, name)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	command := exec.Command(binary, args...)
	command.Dir = dir
	command.Stdin = streams.stdin
	command.Stdout = streams.stdout
	command.Stderr = streams.stderr
	command.Env = environSlice(streams.env)
	return command.Run()
}

func identityOf(info os.FileInfo) fileIdentity {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return fileIdentity{Dev: uint64(stat.Dev), Ino: stat.Ino}
	}
	return fileIdentity{}
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func dirIsEmpty(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) == 0
}

func syncDir(path string) {
	directory, err := os.Open(path)
	if err != nil {
		return
	}
	// Some container filesystems reject directory fsync; the write-ahead
	// ordering is still correct without it.
	_ = directory.Sync()
	_ = directory.Close()
}

func environSlice(env map[string]string) []string {
	result := make([]string, 0, len(env))
	for name, value := range env {
		result = append(result, name+"="+value)
	}
	return result
}

func envValue(env map[string]string, name string) string {
	return env[name]
}

func lookPathIn(env map[string]string, name string) (string, error) {
	if strings.ContainsRune(name, os.PathSeparator) {
		return name, nil
	}
	for _, directory := range filepath.SplitList(env["PATH"]) {
		if directory == "" {
			continue
		}
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%s was not found on PATH", name)
}
