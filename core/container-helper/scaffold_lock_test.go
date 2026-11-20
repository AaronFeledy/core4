package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestScaffoldLockContendsAcrossProcesses(t *testing.T) {
	root := t.TempDir()
	lock, err := acquireScaffoldLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	assertScaffoldLockBusy(t, root)
}

func TestScaffoldLockRetriesReplacedPath(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, scaffoldLockName)
	swap := true
	lock, err := acquireScaffoldLockWithFlock(root, func(fd, flags int) error {
		if swap {
			swap = false
			if err := os.Remove(path); err != nil {
				return err
			}
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				return err
			}
		}
		return syscall.Flock(fd, flags)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	assertScaffoldLockBusy(t, root)
}

func TestScaffoldLockSurvivesHelperKillWhileComposerRuns(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	script := "#!/bin/sh\nprintf 'ready\\n'\nexec /bin/cat\n"
	if err := os.WriteFile(filepath.Join(bin, "composer"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	helper := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestScaffoldLockProcess$", "--", "create")
	helper.Env = []string{"LANDO_TEST_SCAFFOLD_LOCK_ROOT=" + root, "PATH=" + bin}
	helper.Stderr = os.Stderr

	input, inputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer inputWriter.Close()
	output, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	defer outputWriter.Close()
	if err := output.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	helper.Stdin, helper.Stdout = input, outputWriter
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if helper.ProcessState == nil {
			_ = helper.Process.Kill()
			_ = helper.Wait()
		}
	}()
	if err := outputWriter.Close(); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(output)
	if line, err := reader.ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("Composer did not start: %q, %v", line, err)
	}
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	var exit *exec.ExitError
	if err := helper.Wait(); !errors.As(err, &exit) || exit.Sys() != syscall.WaitStatus(syscall.SIGKILL) {
		t.Fatalf("expected the scaffold helper to be killed, got %v", err)
	}
	assertScaffoldLockBusy(t, root)

	if err := inputWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatalf("waiting for Composer to exit: %v", err)
	}
	// Stdout can close at process exit just before the kernel closes fd 3.
	deadline := time.Now().Add(5 * time.Second)
	for {
		lock, err := acquireScaffoldLock(root)
		if err == nil {
			lock.release()
			break
		}
		if err.Error() != scaffoldLockBusyMessage(root) || time.Now().After(deadline) {
			t.Fatalf("cannot take the lock after Composer exited: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestScaffoldLockRejectsUnsafePath(t *testing.T) {
	for name, create := range map[string]func(string) error{
		"directory": func(path string) error { return os.Mkdir(path, 0o700) },
		"symlink":   func(path string) error { return os.Symlink("missing", path) },
		"fifo":      func(path string) error { return syscall.Mkfifo(path, 0o600) },
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, scaffoldLockName)
			if err := create(path); err != nil {
				t.Fatal(err)
			}
			lock, err := acquireScaffoldLock(root)
			if err == nil {
				lock.release()
				t.Fatal("acquired an unsafe lock path")
			}
			if !strings.Contains(err.Error(), "Unsafe Lando scaffold lock path "+path) ||
				!strings.Contains(err.Error(), "Make sure no scaffold is running, then remove it.") {
				t.Fatalf("expected actionable unsafe-path error, got %v", err)
			}
		})
	}
}

func TestScaffoldLockReleaseRemovesFile(t *testing.T) {
	root := t.TempDir()
	lock, err := acquireScaffoldLock(root)
	if err != nil {
		t.Fatal(err)
	}
	lock.release()
	if _, err := os.Lstat(filepath.Join(root, scaffoldLockName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file should be gone after release, got %v", err)
	}
}

func scaffoldLockBusyMessage(root string) string {
	return "Another Lando scaffold is already running for " + root + "."
}

func assertScaffoldLockBusy(t *testing.T, root string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestScaffoldLockProcess$", "--", "probe")
	cmd.Env = append(os.Environ(), "LANDO_TEST_SCAFFOLD_LOCK_ROOT="+root)
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || string(output) != scaffoldLockBusyMessage(root)+"\n" {
		t.Fatalf("expected immediate scaffold lock refusal, got %v, %q", err, output)
	}
}

func TestScaffoldLockProcess(t *testing.T) {
	root := os.Getenv("LANDO_TEST_SCAFFOLD_LOCK_ROOT")
	if root == "" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "create":
		env := map[string]string{"LANDO_CREATE_PROJECT_APP_ROOT": root, "PATH": os.Getenv("PATH")}
		os.Exit(runCreateProject([]string{"acme/fixture"}, helperIO{os.Stdin, os.Stdout, os.Stderr, env}, nil))
	case "probe":
		lock, err := acquireScaffoldLock(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		lock.release()
		os.Exit(0)
	default:
		t.Fatal("unknown scaffold lock subprocess mode")
	}
}
