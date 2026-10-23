package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDispatchRoles(t *testing.T) {
	for _, tc := range []struct {
		name           string
		args           []string
		input          string
		code           int
		output, stderr string
	}{
		{"lando", []string{"log-file"}, "", 127, "", "Missing LANDO_HOST_PROXY_SOCKET or LANDO_HOST_PROXY_URL for host-proxy runLando.\n"},
		{"helper", []string{"log-file"}, "{\"op\":\"close\"}\n", 0, "{\"ok\":true}\n", ""},
		{"helper", []string{"log-file-cleanup", "/invalid"}, "", 0, "{\"ok\":false,\"code\":\"EPROTO\",\"message\":\"invalid helper cleanup path\"}\n", ""},
	} {
		t.Run(tc.name+strings.Join(tc.args, " "), func(t *testing.T) {
			var out, stderr bytes.Buffer
			code := dispatch("/usr/local/bin/"+tc.name, tc.args, helperIO{strings.NewReader(tc.input), &out, &stderr, nil})
			if code != tc.code || out.String() != tc.output || stderr.String() != tc.stderr {
				t.Fatalf("got=%d %q %q", code, out.String(), stderr.String())
			}
		})
	}
	for _, args := range [][]string{nil, {"--help"}, {"unknown"}, {"log-file-cleanup"}, {"log-file-cleanup", "a", "b"}} {
		var out, stderr bytes.Buffer
		if code := dispatch("helper", args, helperIO{stdout: &out, stderr: &stderr}); code != 64 || out.Len() != 0 {
			t.Fatalf("usage code=%d", code)
		}
		for _, role := range []string{"lando", "host-proxy", "log-file", "log-file-cleanup"} {
			if !strings.Contains(stderr.String(), role) {
				t.Fatalf("usage missing %q: %s", role, stderr.String())
			}
		}
	}
}

func TestCompiledBinaryRolesAndLinkedPolicy(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "lando-container-helper")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-X main.forwardPrefixes=LANDO_,LC_ -X main.forwardNames=LANG,GROK_AGENT -X main.blockedNames=LANDO_HOST_PROXY_TOKEN -X main.mustBeOneNames=GROK_AGENT", "-o", binary, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	for _, tc := range []struct {
		argv0  string
		args   []string
		input  string
		code   int
		stdout string
	}{
		{"lando", []string{"log-file"}, "", 127, ""},
		{"helper", []string{"log-file"}, "{\"op\":\"close\"}\n", 0, "{\"ok\":true}\n"},
		{"helper", []string{"--help"}, "", 64, ""},
	} {
		t.Run(tc.argv0+strings.Join(tc.args, " "), func(t *testing.T) {
			cmd := exec.Command(binary, tc.args...)
			cmd.Args[0] = tc.argv0
			cmd.Env = []string{}
			cmd.Stdin = strings.NewReader(tc.input)
			var out, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &stderr
			err := cmd.Run()
			if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != tc.code || out.String() != tc.stdout {
				t.Fatalf("run: %v stdout=%q stderr=%q", err, out.String(), stderr.String())
			}
		})
	}
	requests := make(chan proxyRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		requests <- body
		if r.Header.Get("x-lando-host-proxy-caller") != "unknown" || r.Header.Get("x-lando-host-proxy-depth") != "0" {
			t.Error("wrong default headers")
		}
		for _, chunk := range []string{`{"kind":"stdout","chunk":"ok"}`, "\n{\"kind\":\"exit\",", "\"code\":0}\n"} {
			if _, err := fmt.Fprint(w, chunk); err != nil {
				t.Error(err)
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	defer server.Close()
	url := strings.Replace(server.URL, "127.0.0.1", "0.0.0.0", 1)
	cmd := exec.Command(binary)
	cmd.Args[0] = "/usr/local/bin/lando"
	cmd.Env = []string{"LANDO_HOST_PROXY_URL=" + url, "LANDO_HOST_PROXY_SESSION=s", "LANDO_HOST_PROXY_APP=a", "LANDO_HOST_PROXY_TOKEN=secret", "LANDO_X=x", "LC_ALL=C", "LANG=en", "GROK_AGENT=true", "OTHER=no", "HTTP_PROXY=http://127.0.0.1:1", "ALL_PROXY=http://127.0.0.1:1"}
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("proxy: %v: %s", err, stderr.String())
	}
	if out.String() != "ok" || stderr.Len() != 0 {
		t.Fatalf("streams=%q %q", out.String(), stderr.String())
	}
	body := <-requests
	want := map[string]string{"LANDO_HOST_PROXY_URL": url, "LANDO_HOST_PROXY_SESSION": "s", "LANDO_HOST_PROXY_APP": "a", "LANDO_X": "x", "LC_ALL": "C", "LANG": "en"}
	if !reflect.DeepEqual(body.Env, want) || body.Argv == nil || len(body.Argv) != 0 {
		t.Fatalf("body=%+v", body)
	}
}
