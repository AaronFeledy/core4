package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExecRunUmaskPreservesDirectLaunchFailures(t *testing.T) {
	text := filepath.Join(t.TempDir(), "text")
	if err := os.WriteFile(text, []byte("exit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		program, message string
		code int
	}{
		{"lando-no-such-command", "command not found", 127},
		{text, "cannot execute", 126},
	} {
		t.Run(tc.message, func(t *testing.T) {
			f := execRunStartArgs(t, "--umask", "0022", "--", tc.program)
			state := execRunWait(t, f, 2*time.Second)
			if state.ExitCode() != tc.code || f.stderr.String() != "lando: "+tc.program+": "+tc.message+"\n" {
				t.Fatalf("exit=%d stderr=%q", state.ExitCode(), f.stderr.String())
			}
		})
	}
}

func TestExecRunAppliesUmaskToCreatedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "created")
	f := execRunStartArgs(t, "--umask", "0022", "--", "/bin/sh", "-c", ": > "+path)
	if state := execRunWait(t, f, 2*time.Second); state.ExitCode() != 0 {
		t.Fatalf("exit=%d stderr=%q", state.ExitCode(), f.stderr.String())
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("created mode=%o", info.Mode().Perm())
	}
}
