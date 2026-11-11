package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestExecSignalMatchesOnlyExactSupervisor(t *testing.T) {
	helper := "/run/lando/helper/digest/lando-container-helper"
	nonce := "0123456789abcdef0123456789abcdef"
	for _, tc := range []struct {
		name string
		argv []string
		want bool
	}{
		{"exact", []string{helper, "exec-run", "--nonce", nonce, "--", "sleep", "30"}, true},
		{"single-arg", []string{helper, "exec-run", "--nonce", nonce, "--", "true"}, true},
		{"umask", []string{helper, "exec-run", "--nonce", nonce, "--umask", "0022", "--", "true"}, true},
		{"other-nonce", []string{helper, "exec-run", "--nonce", strings.Repeat("a", 32), "--", "true"}, false},
		{"nonce-prefix", []string{helper, "exec-run", "--nonce", nonce + "a", "--", "true"}, false},
		{"other-path", []string{"/tmp/lando-container-helper", "exec-run", "--nonce", nonce, "--", "true"}, false},
		{"other-role", []string{helper, "exec-signal", "--nonce", nonce, "TERM"}, false},
		{"embedded-command", []string{"sh", "-c", helper + " exec-run --nonce " + nonce + " -- true"}, false},
		{"payload-nonce", []string{helper, "exec-run", "--", "echo", "--nonce", nonce}, false},
		{"missing-payload", []string{helper, "exec-run", "--nonce", nonce, "--"}, false},
		{"invalid-umask", []string{helper, "exec-run", "--nonce", nonce, "--umask", "0999", "--", "true"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmdline := []byte(strings.Join(tc.argv, "\x00") + "\x00")
			if got := execSignalMatches(cmdline, helper, nonce); got != tc.want {
				t.Fatalf("matches=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestExecSignalCancelsOnlyNonceOwnedTree(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "lando-container-helper")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	helper := "/run/lando/helper/test/lando-container-helper"
	for _, sig := range []struct {
		name string
		code int
	}{{"INT", 130}, {"TERM", 143}} {
		t.Run(sig.name, func(t *testing.T) {
			nonce := "0123456789abcdef0123456789abcdef"
			var fixtures []*execRunFixture
			for _, key := range []string{nonce, strings.Repeat("a", 32)} {
				marker := filepath.Join(t.TempDir(), "ready")
				cmd := exec.Command(binary, "exec-run", "--nonce", key, "--", "/bin/sh", "-c", "echo ready > "+marker+"; sleep 30 & wait")
				cmd.Args[0] = helper
				stdin, err := cmd.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				out, stderr := new(bytes.Buffer), new(bytes.Buffer)
				cmd.Stdout, cmd.Stderr = out, stderr
				if err = cmd.Start(); err != nil {
					t.Fatal(err)
				}
				f := &execRunFixture{cmd, stdin, make(chan error, 1), out, stderr}
				go func() { f.done <- cmd.Wait() }()
				t.Cleanup(func() {
					if err := stdin.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
						t.Error(err)
					}
					execRunWait(t, f, 6*time.Second)
				})
				execTestWaitFile(t, marker)
				fixtures = append(fixtures, f)
			}

			control := exec.Command(binary, "exec-signal", "--nonce", nonce, sig.name)
			control.Args[0] = helper
			if output, err := control.CombinedOutput(); err != nil {
				t.Fatalf("signal: %v %s", err, output)
			}
			if st := execRunWait(t, fixtures[0], 6*time.Second); st.ExitCode() != sig.code {
				t.Fatalf("exit=%d stderr=%q", st.ExitCode(), fixtures[0].stderr.String())
			}
			if err := syscall.Kill(fixtures[1].cmd.Process.Pid, 0); err != nil {
				t.Fatalf("other supervisor was signaled: %v", err)
			}
			control = exec.Command(binary, "exec-signal", "--nonce", nonce, sig.name)
			control.Args[0] = helper
			if err := control.Run(); err == nil || control.ProcessState.ExitCode() != execSignalNotFound {
				t.Fatalf("not-found exit=%v err=%v", control.ProcessState, err)
			}
		})
	}
}
