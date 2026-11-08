package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Each exec-run owns Wait4; run it in a child process so it never competes
// with the Go test runner's subprocess reaper.
func TestExecRunProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_EXEC_RUN") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			scan := execDescendants
			if root := os.Getenv("LANDO_TEST_EXEC_PROC_ROOT"); root != "" {
				scan = func() ([]int, error) { return execDescendantsAt(root, 73) }
			}
			os.Exit(runExecRunWithScan(os.Args[i:], helperIO{os.Stdin, os.Stdout, os.Stderr, nil}, scan))
		}
	}
	os.Exit(125)
}

type execRunFixture struct {
	cmd            *exec.Cmd
	stdin          io.WriteCloser
	done           chan error
	stdout, stderr *bytes.Buffer
}

func execRunStart(t *testing.T, argv ...string) *execRunFixture {
	t.Helper()
	if _, err := execDescendants(); err != nil {
		t.Skip("kernel does not expose process children: ", err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-test.run=^TestExecRunProcess$", "--"}, argv...)
	cmd := exec.Command(binary, args...)
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_RUN=1")
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
		_ = stdin.Close()
		select {
		case <-f.done:
		case <-time.After(7 * time.Second):
			_ = cmd.Process.Kill()
			<-f.done
		}
	})
	return f
}

func execRunWrite(t *testing.T, f *execRunFixture, frames ...[]byte) {
	t.Helper()
	for _, frame := range frames {
		if _, err := f.stdin.Write(frame); err != nil {
			t.Fatalf("control write: %v", err)
		}
	}
}

func execRunWait(t *testing.T, f *execRunFixture, timeout time.Duration) *os.ProcessState {
	t.Helper()
	select {
	case err := <-f.done:
		f.done <- err
		if err == nil {
			return f.cmd.ProcessState
		}
		if e, ok := err.(*exec.ExitError); ok {
			return e.ProcessState
		}
		t.Fatalf("wait: %v", err)
	case <-time.After(timeout):
		t.Fatal("exec-run did not exit")
	}
	return nil
}

func execTestWaitFile(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil && len(b) > 0 {
			return b
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("workload did not become ready")
	return nil
}

func TestExecRunByteExactStdinAndStdout(t *testing.T) {
	f := execRunStart(t, "/bin/sh", "-c", "cat; printf 'err\\000bytes\\377' >&2; exit 23")
	payload := []byte("raw\x00input\xff\n")
	execRunWrite(t, f, execEncodeFrame(execFrameData, payload), execEncodeFrame(execFrameEOF, nil))
	st := execRunWait(t, f, 5*time.Second)
	if st.ExitCode() != 23 {
		t.Fatalf("exit=%d stderr=%q", st.ExitCode(), f.stderr.String())
	}
	if f.stdout.String() != string(payload) || f.stderr.String() != "err\x00bytes\xff" {
		t.Fatalf("payload %q %q", f.stdout.String(), f.stderr.String())
	}
}

func TestExecRunLogicalEOFKeepsControlOpenForSignal(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	received := filepath.Join(t.TempDir(), "signal")
	f := execRunStart(t, "/bin/sh", "-c", "trap 'printf INT > "+received+"; exit 42' INT; cat > /dev/null; echo ready > "+marker+"; while :; do sleep 1; done")
	execRunWrite(t, f, execEncodeFrame(execFrameEOF, nil))
	execTestWaitFile(t, marker)
	execRunWrite(t, f, execEncodeFrame(execFrameSignal, []byte{execSignalInterrupt}))
	st := execRunWait(t, f, 5*time.Second)
	if st.ExitCode() != 130 {
		t.Fatalf("exit=%d stderr=%q", st.ExitCode(), f.stderr.String())
	}
	if b := execTestWaitFile(t, received); string(b) != "INT" {
		t.Fatalf("received %q", b)
	}
}

func TestExecRunForwardsRequestedSignals(t *testing.T) {
	for _, tc := range []struct {
		name string
		sig  byte
		want int
	}{
		{"int", execSignalInterrupt, 128 + int(syscall.SIGINT)},
		{"term", execSignalTerminate, 128 + int(syscall.SIGTERM)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "ready")
			short := map[byte]string{execSignalInterrupt: "INT", execSignalTerminate: "TERM"}[tc.sig]
			f := execRunStart(t, "/bin/sh", "-c", "trap 'exit 0' "+short+"; echo ready > "+marker+"; while :; do sleep 1; done")
			execRunWrite(t, f, execEncodeFrame(execFrameEOF, nil))
			execTestWaitFile(t, marker)
			execRunWrite(t, f, execEncodeFrame(execFrameSignal, []byte{tc.sig}))
			st := execRunWait(t, f, 5*time.Second)
			if st.ExitCode() != tc.want {
				t.Fatalf("exit=%d want=%d stderr=%q", st.ExitCode(), tc.want, f.stderr.String())
			}
		})
	}
}

func TestExecRunRawEOFTerminatesOwnedTree(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	f := execRunStart(t, "/bin/sh", "-c", "trap '' TERM; echo $$ > "+marker+"; while :; do sleep 1; done")
	execRunWrite(t, f, execEncodeFrame(execFrameEOF, nil))
	pid, _ := strconv.Atoi(strings.TrimSpace(string(execTestWaitFile(t, marker))))
	if err := f.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	st := execRunWait(t, f, 6*time.Second)
	if st.ExitCode() != 128+int(syscall.SIGTERM) {
		t.Fatalf("exit=%d", st.ExitCode())
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("payload remains: %v", err)
	}
}

func TestExecRunKillsAdoptedSetsidDescendants(t *testing.T) {
	setsid, err := exec.LookPath("setsid")
	if err != nil {
		t.Skip("setsid is unavailable")
	}
	marker := filepath.Join(t.TempDir(), "escaped-pid")
	f := execRunStart(t, "/bin/sh", "-c", setsid+" /bin/sh -c 'trap \"\" TERM; echo $$ > "+marker+"; while :; do sleep 1; done' & wait")
	execRunWrite(t, f, execEncodeFrame(execFrameEOF, nil))
	pid, _ := strconv.Atoi(strings.TrimSpace(string(execTestWaitFile(t, marker))))
	execRunWrite(t, f, execEncodeFrame(execFrameSignal, []byte{execSignalTerminate}))
	st := execRunWait(t, f, 6*time.Second)
	if st.ExitCode() != 128+int(syscall.SIGTERM) {
		t.Fatalf("exit=%d", st.ExitCode())
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("escaped descendant remains: %v", err)
	}
}

func TestExecRunNaturalExitPreservesBackgroundAndUnrelatedProcesses(t *testing.T) {
	setsid, err := exec.LookPath("setsid")
	if err != nil {
		t.Skip("setsid unavailable")
	}
	sentinel := exec.Command("/bin/sleep", "30")
	if err = sentinel.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { sentinel.Process.Kill(); sentinel.Wait() }()
	marker := filepath.Join(t.TempDir(), "escapee")
	// Background descendants keep the inherited stdout write end open, so do not
	// rely on Cmd.Wait pipe-drain alone to observe helper completion.
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"-test.run=^TestExecRunProcess$", "--", "/bin/sh", "-c",
		setsid + " /bin/sh -c 'trap \"\" TERM; echo $$ > " + marker + "; while :; do sleep 1; done' & while [ ! -s " + marker + " ]; do sleep 0.01; done; exit 7"}
	cmd := exec.Command(binary, args...)
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_RUN=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	// Discard payload streams so Wait is not blocked by background holders.
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	if _, err = stdin.Write(execEncodeFrame(execFrameEOF, nil)); err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(execTestWaitFile(t, marker))))
	select {
	case err := <-done:
		code := 0
		if err == nil {
			code = cmd.ProcessState.ExitCode()
		} else if e, ok := err.(*exec.ExitError); ok {
			code = e.ExitCode()
		} else {
			t.Fatalf("wait: %v", err)
		}
		if code != 7 {
			t.Fatalf("exit=%d", code)
		}
		done <- err
	case <-time.After(5 * time.Second):
		t.Fatal("helper did not exit after main completion")
	}
	defer syscall.Kill(pid, syscall.SIGKILL)
	if err = syscall.Kill(pid, 0); err != nil {
		t.Fatalf("background process was terminated: %v", err)
	}
	if err = syscall.Kill(sentinel.Process.Pid, 0); err != nil {
		t.Fatalf("unrelated process affected: %v", err)
	}
}

func TestExecRunLaunchFailures(t *testing.T) {
	for _, scenario := range []struct {
		name, program, content, message string
		mode                            os.FileMode
		code                            int
	}{
		{name: "missing-path", program: "/definitely-no-such-executable", code: 127, message: "command not found"},
		{name: "missing-PATH", program: "lando-no-such-command", code: 127, message: "command not found"},
		{name: "permission", content: "not executable\n", mode: 0600, code: 126, message: "cannot execute"},
		{name: "format", content: "not an executable format\n", mode: 0700, code: 126, message: "cannot execute"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			program := scenario.program
			if program == "" {
				program = filepath.Join(t.TempDir(), "payload")
				if err := os.WriteFile(program, []byte(scenario.content), scenario.mode); err != nil {
					t.Fatal(err)
				}
			}
			f := execRunStart(t, program, "arg")
			st := execRunWait(t, f, 5*time.Second)
			if st.ExitCode() != scenario.code {
				t.Fatalf("exit=%d stderr=%q", st.ExitCode(), f.stderr.String())
			}
			want := "lando: " + program + ": " + scenario.message + "\n"
			if f.stdout.Len() != 0 || f.stderr.String() != want {
				t.Fatalf("payload output: %q %q want %q", f.stdout.String(), f.stderr.String(), want)
			}
		})
	}
}

func TestExecRunDataBackpressureDoesNotBlockSignal(t *testing.T) {
	// Child never reads stdin, so DATA writes block on the pipe. A later SIGNAL
	// must still be observed and terminate the tree (see run-loop comment).
	marker := filepath.Join(t.TempDir(), "ready")
	f := execRunStart(t, "/bin/sh", "-c", "echo ready > "+marker+"; while :; do sleep 1; done")
	execTestWaitFile(t, marker)
	big := bytes.Repeat([]byte("x"), execFrameMaxData)
	wrote := 0
	for i := 0; i < 8; i++ {
		frame := execEncodeFrame(execFrameData, big)
		n, err := f.stdin.Write(frame)
		wrote += n
		if err != nil {
			// Helper must have accepted at least one full blocked DATA frame into
			// memory before any write error; the SIGNAL below is the real assertion.
			if wrote < execFrameHeaderLen+execFrameMaxData {
				t.Fatalf("control DATA write %d after %d bytes: %v", i, wrote, err)
			}
			break
		}
	}
	// Even if the control pipe is under backpressure, a SIGNAL frame must be
	// readable once prior DATA has been buffered off the wire.
	if _, err := f.stdin.Write(execEncodeFrame(execFrameSignal, []byte{execSignalTerminate})); err != nil {
		t.Fatalf("signal write: %v", err)
	}
	st := execRunWait(t, f, 6*time.Second)
	if st.ExitCode() != 128+int(syscall.SIGTERM) {
		t.Fatalf("exit=%d stderr=%q", st.ExitCode(), f.stderr.String())
	}
}

func TestExecRunDispatchArgv(t *testing.T) {
	var out, stderr bytes.Buffer
	code := dispatch("helper", []string{"exec-run"}, helperIO{stdout: &out, stderr: &stderr})
	if code != 64 {
		t.Fatalf("code=%d", code)
	}
	code = dispatch("helper", []string{"exec-run", "no-dashdash", "true"}, helperIO{stdout: &out, stderr: &stderr})
	if code != 64 {
		t.Fatalf("code=%d", code)
	}
}

func TestExecRunRefusesUnsupportedProcBeforePayload(t *testing.T) {
	procRoot := t.TempDir()
	os.Mkdir(filepath.Join(procRoot, "self"), 0700)
	os.WriteFile(filepath.Join(procRoot, "self", "stat"), []byte("73 (self) S 0"), 0600)
	os.WriteFile(filepath.Join(procRoot, "self", "status"), []byte("NStgid:\t74\n"), 0600)
	binary, _ := os.Executable()
	marker := filepath.Join(t.TempDir(), "spawned")
	cmd := exec.Command(binary, "-test.run=^TestExecRunProcess$", "--", "/bin/sh", "-c", "touch "+marker)
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_RUN=1", "LANDO_TEST_EXEC_PROC_ROOT="+procRoot)
	err := cmd.Run()
	if err == nil {
		t.Fatal("unsupported exec-run succeeded")
	}
	if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 125 {
		t.Fatalf("exit: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("payload started before capability validation")
	}
}
