package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func runFakeComposer(args []string) int {
	env := envMap(os.Environ())
	if env["LANDO_TEST_COMPOSER_RECIPE"] == "contrib" {
		log, err := os.OpenFile(env["LANDO_TEST_COMPOSER_LOG"], os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
		if err != nil {
			return 2
		}
		encodeErr := json.NewEncoder(log).Encode(args)
		if closeErr := log.Close(); encodeErr != nil || closeErr != nil {
			fmt.Fprintln(os.Stderr, encodeErr, closeErr)
			return 2
		}
		return fakeContribComposer(args, env)
	}
	if len(args) == 0 {
		return 2
	}
	workingDir := ""
	if strings.HasPrefix(args[0], "--working-dir=") {
		workingDir = strings.TrimPrefix(args[0], "--working-dir=")
		args = args[1:]
	}
	command := args[0]
	arguments := args[1:]
	positional := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if !strings.HasPrefix(argument, "--") {
			positional = append(positional, argument)
		}
	}
	logLine := command
	if command == "run-script" && len(positional) > 0 {
		logLine += " " + positional[0]
	}
	if command == "config" && len(positional) > 0 && strings.HasPrefix(positional[0], "allow-plugins.") {
		logLine += " " + strings.Join(arguments, " ")
	}
	if logPath := env["LANDO_TEST_COMPOSER_LOG"]; logPath != "" {
		file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
		if err == nil {
			_, _ = file.WriteString(logLine + "\n")
			_ = file.Close()
		}
	}
	switch env["LANDO_TEST_COMPOSER_RECIPE"] {
	case "drupal":
		return fakeDrupalComposer(command, workingDir, positional)
	case "cms":
		return fakeCmsComposer(command, workingDir, positional, env)
	default:
		return fakeCreateComposer(command, positional, env)
	}
}

func fakeCreateComposer(command string, positional []string, env map[string]string) int {
	release := env["LANDO_TEST_COMPOSER_RELEASE"]
	switch command {
	case "create-project":
		if env["LANDO_TEST_COMPOSER_FAIL_CREATE"] == "1" {
			return 1
		}
		if len(positional) < 2 {
			return 2
		}
		target := positional[1]
		if err := os.MkdirAll(filepath.Join(target, "app"), 0o755); err != nil {
			return 2
		}
		if err := os.MkdirAll(filepath.Join(target, "public"), 0o755); err != nil {
			return 2
		}
		_ = os.WriteFile(filepath.Join(target, "app", "index.php"), []byte(release+"\n"), 0o644)
		_ = os.WriteFile(filepath.Join(target, "public", "index.php"), []byte(release+"\n"), 0o644)
		scripts := map[string]any{}
		switch env["LANDO_TEST_COMPOSER_HOOKS"] {
		case "both":
			scripts["post-root-package-install"] = []string{"true"}
			scripts["post-create-project-cmd"] = []string{"true"}
		case "empty":
			scripts["post-root-package-install"] = []string{}
			scripts["post-create-project-cmd"] = []string{}
		case "failing-root":
			scripts["post-root-package-install"] = []string{"false"}
		case "failing-create":
			scripts["post-create-project-cmd"] = []string{"false"}
		}
		data, _ := json.Marshal(map[string]any{"scripts": scripts})
		_ = os.WriteFile(filepath.Join(target, "composer.json"), data, 0o644)
		for _, extra := range strings.Split(env["LANDO_TEST_COMPOSER_EXTRA"], "\n") {
			if extra == "" {
				continue
			}
			_ = os.WriteFile(filepath.Join(target, extra), []byte("extra\n"), 0o644)
		}
		if env["LANDO_TEST_COMPOSER_NEWLINE"] == "1" {
			_ = os.WriteFile(filepath.Join(target, "bad\nname"), []byte("extra\n"), 0o644)
		}
		return 0
	case "run-script":
		if len(positional) == 0 {
			return 2
		}
		switch env["LANDO_TEST_COMPOSER_HOOKS"] {
		case "empty":
			return 2
		case "failing-root":
			if positional[0] == "post-root-package-install" {
				return 1
			}
		case "failing-create":
			if positional[0] == "post-create-project-cmd" {
				return 1
			}
		}
		return 0
	case "install":
		if env["LANDO_TEST_COMPOSER_FAIL_INSTALL"] == "1" {
			return 42
		}
		_ = os.MkdirAll("vendor", 0o755)
		_ = os.WriteFile(filepath.Join("vendor", "autoload.php"), []byte("installed\n"), 0o644)
		_ = os.WriteFile("composer.lock", []byte("{}\n"), 0o644)
		return 0
	}
	return 2
}

func fakeDrupalComposer(command string, workingDir string, positional []string) int {
	switch command {
	case "create-project":
		if len(positional) < 2 {
			return 2
		}
		target := positional[1]
		_ = os.MkdirAll(filepath.Join(target, "web"), 0o755)
		_ = os.MkdirAll(filepath.Join(target, "vendor", "bin"), 0o755)
		_ = os.WriteFile(filepath.Join(target, "composer.json"), []byte("{}\n"), 0o644)
		_ = os.WriteFile(filepath.Join(target, "vendor", "bin", "drush"), []byte("#!/bin/sh\n"), 0o755)
		return 0
	case "require":
		if workingDir == "" {
			return 2
		}
		_ = os.MkdirAll(filepath.Join(workingDir, "vendor", "bin"), 0o755)
		_ = os.WriteFile(filepath.Join(workingDir, "vendor", "bin", "drush"), []byte("#!/bin/sh\n"), 0o755)
		return 0
	}
	return 2
}

func writeFakeJSON(path string, value any) {
	data, _ := json.MarshalIndent(value, "", "  ")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, data, 0o644)
}

func readFakeJSON(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	return readFakeJSONBytes(data)
}

func readFakeJSONBytes(data []byte) map[string]any {
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	return value
}

func fakeLicense(value any) []any {
	if entries, ok := value.([]any); ok {
		return entries
	}
	return []any{value}
}
