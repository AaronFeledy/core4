package main

import (
	"os"
	"path/filepath"
	"testing"
)

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

func TestExecProcNamespaceIsValidatedOnEveryScan(t *testing.T) {
	root := t.TempDir()
	os.Mkdir(filepath.Join(root, "self"), 0700)
	os.Mkdir(filepath.Join(root, "73"), 0700)
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("73 (self) S 0"), 0600)
	os.WriteFile(filepath.Join(root, "self", "status"), []byte("NStgid:\t73\n"), 0600)
	os.WriteFile(filepath.Join(root, "73", "stat"), []byte("73 (self) S 0"), 0600)
	if _, err := execDescendantsAt(root, 73); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("74 (ancestor-self) S 0"), 0600)
	if children, err := execDescendantsAt(root, 73); err == nil || len(children) != 0 {
		t.Fatalf("namespace change accepted: %v %v", children, err)
	}
	os.WriteFile(filepath.Join(root, "self", "stat"), []byte("73 (self) S 0"), 0600)
	os.WriteFile(filepath.Join(root, "self", "status"), []byte("NStgid:\t73 73\n"), 0600)
	if children, err := execDescendantsAt(root, 73); err == nil || len(children) != 0 {
		t.Fatalf("coincident ancestor accepted: %v %v", children, err)
	}
}

func TestExecDescendantsRefusesUnsupportedProc(t *testing.T) {
	for _, scenario := range []string{"missing-proc", "mismatched-namespace", "coincident-ancestor", "missing-nstgid", "malformed-nstgid", "wrong-nstgid"} {
		t.Run(scenario, func(t *testing.T) {
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
			if _, err := execDescendantsAt(procRoot, 73); err == nil {
				t.Fatal("accepted unsupported proc")
			}
		})
	}
}
