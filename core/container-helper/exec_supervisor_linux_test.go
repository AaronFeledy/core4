package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Each supervisor runs in its own process: its Wait4 owner must never compete
// with the Go test runner's subprocess reaper.
func TestExecSupervisorProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_EXEC_SUPERVISOR") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			scan := execDirectChildren
			if root := os.Getenv("LANDO_TEST_EXEC_PROC_ROOT"); root != "" {
				scan = func() ([]int, error) { return execDirectChildrenAt(root, 73) }
			}
			os.Exit(runExecSupervisorWithScan(os.Args[i+1:], helperIO{os.Stdin, os.Stdout, os.Stderr, nil}, scan))
		}
	}
	os.Exit(125)
}

type supervisorFixture struct {
	dir, nonce     string
	cmd            *exec.Cmd
	done           chan error
	stdout, stderr *bytes.Buffer
}

func execTestControl(t *testing.T, f *supervisorFixture, op string) execReply {
	t.Helper()
	var out bytes.Buffer
	runExecControl([]string{f.dir, f.nonce, op}, helperIO{stdout: &out})
	var r execReply
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("control %s: %s %v", op, out.String(), err)
	}
	return r
}
func execTestSupervisor(t *testing.T, argv ...string) *supervisorFixture {
	t.Helper()
	if _, err := execDirectChildren(); err != nil {
		t.Skip("kernel does not expose process children: ", err)
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	dir := "/tmp/lando-exec-session-" + nonce
	if err := execPrivateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := execMark(dir, "initialized"); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-test.run=^TestExecSupervisorProcess$", "--", dir, nonce, "--"}, argv...)
	cmd := exec.Command(binary, args...)
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_SUPERVISOR=1")
	out, stderr := new(bytes.Buffer), new(bytes.Buffer)
	cmd.Stdout, cmd.Stderr = out, stderr
	cmd.Stdin = strings.NewReader("raw\x00input\xff\n")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	f := &supervisorFixture{dir, nonce, cmd, make(chan error, 1), out, stderr}
	go func() { f.done <- cmd.Wait() }()
	t.Cleanup(func() {
		execTestControl(t, f, "cancel")
		execTestControl(t, f, "collect")
		select {
		case <-f.done:
		case <-time.After(7 * time.Second):
			cmd.Process.Kill()
		}
		os.RemoveAll(dir)
	})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r := execTestControl(t, f, "ready")
		if r.OK && r.State == "ready" {
			return f
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("supervisor never ready")
	return nil
}
func execTestFinished(t *testing.T, f *supervisorFixture) execReply {
	t.Helper()
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		r := execTestControl(t, f, "status")
		if !r.OK {
			t.Fatalf("supervisor failure: %+v", r)
		}
		if r.Joined {
			return r
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("supervisor did not join")
	return execReply{}
}
func TestExecSupervisorRawPayloadAndActualStatus(t *testing.T) {
	f := execTestSupervisor(t, "/bin/sh", "-c", "cat; printf 'err\\000bytes\\377' >&2; exit 23")
	if r := execTestControl(t, f, "launch"); !r.OK || r.State != "running" {
		t.Fatalf("launch: %+v", r)
	}
	r := execTestFinished(t, f)
	if r.ExitCode == nil || *r.ExitCode != 23 || r.State != "finished" {
		t.Fatalf("result: %+v", r)
	}
	if r = execTestControl(t, f, "collect"); !r.OK || !r.Joined {
		t.Fatalf("collect: %+v", r)
	}
	select {
	case err := <-f.done:
		if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 23 {
			t.Fatalf("exit: %v", err)
		}
		f.done <- err
	case <-time.After(2 * time.Second):
		t.Fatal("collect did not release supervisor")
	}
	if f.stdout.String() != "raw\x00input\xff\n" || f.stderr.String() != "err\x00bytes\xff" {
		t.Fatalf("payload %q %q", f.stdout.String(), f.stderr.String())
	}
}
func TestExecCancelBeforeLaunchIsPermanent(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "spawned")
	f := execTestSupervisor(t, "/bin/sh", "-c", "touch "+marker)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("child ran before launch")
	}
	if r := execTestControl(t, f, "cancel"); !r.OK || !r.Joined || r.ExitCode != nil {
		t.Fatalf("cancel: %+v", r)
	}
	if r := execTestControl(t, f, "launch"); !r.OK || r.State != "cancelled" {
		t.Fatalf("late launch: %+v", r)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("cancelled child spawned")
	}
}
func TestExecSupervisorKillsAdoptedSetsidDescendants(t *testing.T) {
	setsid, err := exec.LookPath("setsid")
	if err != nil {
		t.Skip("setsid is unavailable")
	}
	marker := filepath.Join(t.TempDir(), "escaped-pid")
	f := execTestSupervisor(t, "/bin/sh", "-c", setsid+" /bin/sh -c 'trap \"\" TERM; echo $$ > "+marker+"; while :; do sleep 1; done' & wait")
	if r := execTestControl(t, f, "launch"); !r.OK {
		t.Fatalf("launch: %+v", r)
	}
	var pid int
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, e := os.ReadFile(marker)
		if e == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			if pid > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("descendant not ready")
	}
	r := execTestControl(t, f, "cancel")
	if !r.OK || !r.Joined || r.ExitCode == nil {
		t.Fatalf("cancel: %+v", r)
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("escaped descendant remains: %v", err)
	}
}
func TestExecCancellationTombstoneBeforeInit(t *testing.T) {
	var random [16]byte
	rand.Read(random[:])
	nonce := hex.EncodeToString(random[:])
	dir := "/tmp/lando-exec-session-" + nonce
	defer os.RemoveAll(dir)
	f := &supervisorFixture{dir: dir, nonce: nonce}
	if r := execTestControl(t, f, "cancel"); !r.OK || r.State != "cancelled" || !r.Joined {
		t.Fatalf("cancel: %+v", r)
	}
	if !execExists(dir, "cancelled") {
		t.Fatal("missing durable cancellation tombstone")
	}
}

func TestExecSupervisorRefusesUnsupportedProcBeforePayload(t *testing.T) {
	for _, scenario := range []string{"missing-proc", "mismatched-namespace", "coincident-ancestor", "missing-nstgid", "malformed-nstgid", "wrong-nstgid"} {
		t.Run(scenario, func(t *testing.T) {
			var random [16]byte
			rand.Read(random[:])
			nonce := hex.EncodeToString(random[:])
			dir := "/tmp/lando-exec-session-" + nonce
			defer os.RemoveAll(dir)
			if err := execPrivateDirectory(dir); err != nil {
				t.Fatal(err)
			}
			execMark(dir, "initialized")
			procRoot := t.TempDir()
			if scenario != "missing-proc" {
				os.Mkdir(filepath.Join(procRoot, "self"), 0700)
				stat := "73 (self) S 0"
				if scenario == "mismatched-namespace" {
					stat = "2147483647 (ancestor-namespace) S 0"
				}
				status := "NStgid:\t73\n"
				switch scenario {
				case "coincident-ancestor":
					status = "NStgid:\t73 73\n"
				case "missing-nstgid":
					status = "Name:\ttest\n"
				case "malformed-nstgid":
					status = "NStgid:\tnope\n"
				case "wrong-nstgid":
					status = "NStgid:\t74\n"
				}
				os.WriteFile(filepath.Join(procRoot, "self", "stat"), []byte(stat), 0600)
				os.WriteFile(filepath.Join(procRoot, "self", "status"), []byte(status), 0600)
			}
			binary, _ := os.Executable()
			marker := filepath.Join(t.TempDir(), "spawned")
			sentinel := exec.Command("/bin/sleep", "30")
			if err := sentinel.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { sentinel.Process.Kill(); sentinel.Wait() }()
			cmd := exec.Command(binary, "-test.run=^TestExecSupervisorProcess$", "--", dir, nonce, "--", "/bin/sh", "-c", "touch "+marker)
			cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_SUPERVISOR=1", "LANDO_TEST_EXEC_PROC_ROOT="+procRoot)
			if err := cmd.Run(); err == nil {
				t.Fatal("unsupported supervisor succeeded")
			}
			r, ok := execLoad(dir)
			if !ok || r.OK || r.Error != "proc-unavailable" {
				t.Fatalf("receipt: %+v %t", r, ok)
			}
			if execExists(dir, "launched") || execExists(dir, "control") {
				t.Fatal("unsupported supervisor became ready or launched")
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("payload started before capability validation")
			}
			if err := syscall.Kill(sentinel.Process.Pid, 0); err != nil {
				t.Fatalf("unrelated process affected: %v", err)
			}
		})
	}
}
func TestExecProcNamespaceIsValidatedOnEveryScan(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "self"), 0700)
	os.Mkdir(filepath.Join(root, "73"), 0700)
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("73 (self) S 0"), 0600)
	os.WriteFile(filepath.Join(root, "self", "status"), []byte("NStgid: 73\n"), 0600)
	os.WriteFile(filepath.Join(root, "73", "stat"), []byte("73 (self) S 0"), 0600)
	if _, err := execDirectChildrenAt(root, 73); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("74 (ancestor-self) S 0"), 0600)
	if children, err := execDirectChildrenAt(root, 73); err == nil || len(children) != 0 {
		t.Fatalf("namespace change accepted: %v %v", children, err)
	}
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("73 (self) S 0"), 0600)
	os.WriteFile(filepath.Join(root, "self", "status"), []byte("NStgid: 73 73\n"), 0600)
	if children, err := execDirectChildrenAt(root, 73); err == nil || len(children) != 0 {
		t.Fatalf("coincident ancestor accepted: %v %v", children, err)
	}

}
func TestExecCleanupRequiresJoinedReceiptAndRejectsUnknownMembers(t *testing.T) {
	var random [16]byte
	rand.Read(random[:])
	nonce := hex.EncodeToString(random[:])
	dir := "/tmp/lando-exec-session-" + nonce
	defer os.RemoveAll(dir)
	execPrivateDirectory(dir)
	cleanup := func() execReply {
		var out bytes.Buffer
		runExecCleanup([]string{dir, nonce}, helperIO{stdout: &out})
		var r execReply
		json.Unmarshal(out.Bytes(), &r)
		return r
	}
	if r := cleanup(); r.OK || r.Error != "cleanup-not-confirmed" {
		t.Fatalf("unconfirmed: %+v", r)
	}
	execSave(dir, execReply{OK: true, State: "cancelled", Joined: true})
	os.Symlink("/tmp", filepath.Join(dir, "unexpected"))
	if r := cleanup(); r.OK || r.Error != "unsafe-session" {
		t.Fatalf("unexpected member: %+v", r)
	}
	os.Remove(filepath.Join(dir, "unexpected"))
	if r := cleanup(); !r.OK {
		t.Fatalf("cleanup: %+v", r)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("session artifacts remain")
	}
}

func TestExecProcStatParentParser(t *testing.T) {
	for _, data := range []string{"73 (a name) S 19 0", "73 (a ) ( tricky\nname)) Z 19 0"} {
		p, err := execStatParent(data, 73)
		if err != nil || p != 19 {
			t.Fatalf("parse %q: %d %v", data, p, err)
		}
	}
	for _, data := range []string{"74 (wrong pid) S 19", "73 (missing close S 19", "73 (x) S nope", "73 (x) S -1", "73 (x) S"} {
		if _, err := execStatParent(data, 73); err == nil {
			t.Fatalf("accepted %q", data)
		}
	}
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
func TestExecSupervisorForwardsRequestedSignal(t *testing.T) {
	for _, signal := range []string{"SIGINT", "SIGTERM"} {
		t.Run(signal, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "ready")
			received := filepath.Join(t.TempDir(), "signal")
			short := strings.TrimPrefix(signal, "SIG")
			f := execTestSupervisor(t, "/bin/sh", "-c", "trap 'printf "+short+" > "+received+"; exit 42' "+short+"; echo ready > "+marker+"; while :; do sleep 1; done")
			if r := execTestControl(t, f, "launch"); !r.OK {
				t.Fatalf("launch: %+v", r)
			}
			execTestWaitFile(t, marker)
			var out bytes.Buffer
			runExecControl([]string{f.dir, f.nonce, "cancel", signal}, helperIO{stdout: &out})
			var r execReply
			json.Unmarshal(out.Bytes(), &r)
			if !r.OK || !r.Joined || r.ExitCode == nil || *r.ExitCode != 42 {
				t.Fatalf("signal result: %+v", r)
			}
			if b := execTestWaitFile(t, received); string(b) != short {
				t.Fatalf("received %q", b)
			}
		})
	}
}
func TestExecNaturalExitJoinsEscapeesAndPreservesUnrelatedProcess(t *testing.T) {
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
	f := execTestSupervisor(t, "/bin/sh", "-c", setsid+" /bin/sh -c 'trap \"\" TERM; echo $$ > "+marker+"; while :; do sleep 1; done' & while [ ! -s "+marker+" ]; do sleep 0.01; done; exit 7")
	if r := execTestControl(t, f, "launch"); !r.OK {
		t.Fatalf("launch: %+v", r)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(execTestWaitFile(t, marker))))
	r := execTestFinished(t, f)
	if r.ExitCode == nil || *r.ExitCode != 7 || !r.Joined {
		t.Fatalf("natural result: %+v", r)
	}
	if err = syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("escapee remains: %v", err)
	}
	if err = syscall.Kill(sentinel.Process.Pid, 0); err != nil {
		t.Fatalf("unrelated process affected: %v", err)
	}
}
func TestExecLaunchGateExpiresWithoutSpawning(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "spawned")
	f := execTestSupervisor(t, "/bin/sh", "-c", "touch "+marker)
	select {
	case err := <-f.done:
		if err != nil {
			t.Fatalf("unlaunched exit: %v", err)
		}
		f.done <- err
	case <-time.After(12 * time.Second):
		t.Fatal("launch gate did not expire")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("expired session spawned payload")
	}
	r, ok := execLoad(f.dir)
	if !ok || !r.OK || r.State != "cancelled" || !r.Joined || r.ExitCode != nil {
		t.Fatalf("expired receipt: %+v", r)
	}
}

func TestExecLaunchFailureDoesNotInventPayloadExit(t *testing.T) {
	f := execTestSupervisor(t, "/definitely-no-such-executable")
	r := execTestControl(t, f, "launch")
	if r.OK || r.Error != "launch-failed" || r.ExitCode != nil || r.Joined {
		t.Fatalf("launch failure: %+v", r)
	}
	r = execTestControl(t, f, "collect")
	if r.OK || r.Error != "launch-failed" {
		t.Fatalf("failure collection: %+v", r)
	}
}
func TestExecLostControlLeaseKillsAndJoinsPayload(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	f := execTestSupervisor(t, "/bin/sh", "-c", "trap '' TERM; echo $$ > "+marker+"; while :; do sleep 1; done")
	if r := execTestControl(t, f, "launch"); !r.OK {
		t.Fatalf("launch: %+v", r)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(execTestWaitFile(t, marker))))
	select {
	case err := <-f.done:
		if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 137 {
			t.Fatalf("lease exit: %v", err)
		}
		f.done <- err
	case <-time.After(13 * time.Second):
		t.Fatal("lost lease did not release supervisor")
	}
	r, ok := execLoad(f.dir)
	if !ok || !r.OK || !r.Joined || r.ExitCode == nil || *r.ExitCode != 137 {
		t.Fatalf("lease receipt: %+v", r)
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("lost-control payload remains: %v", err)
	}
}
