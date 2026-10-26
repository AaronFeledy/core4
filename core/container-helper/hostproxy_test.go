package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func proxyEnv() map[string]string {
	return map[string]string{"LANDO_HOST_PROXY_SOCKET": "/missing/socket", "LANDO_HOST_PROXY_SESSION": "session", "LANDO_HOST_PROXY_APP": "app", "LANDO_HOST_PROXY_TOKEN": "token"}
}

func TestMissingProxyEnvironment(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		remove        []string
	}{
		{"target", "LANDO_HOST_PROXY_SOCKET or LANDO_HOST_PROXY_URL", []string{"LANDO_HOST_PROXY_SOCKET", "LANDO_HOST_PROXY_SESSION"}},
		{"session first", "LANDO_HOST_PROXY_SESSION", []string{"LANDO_HOST_PROXY_SESSION", "LANDO_HOST_PROXY_APP", "LANDO_HOST_PROXY_TOKEN"}},
		{"app second", "LANDO_HOST_PROXY_APP", []string{"LANDO_HOST_PROXY_APP", "LANDO_HOST_PROXY_TOKEN"}},
		{"token third", "LANDO_HOST_PROXY_TOKEN", []string{"LANDO_HOST_PROXY_TOKEN"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := proxyEnv()
			for _, key := range tc.remove {
				delete(env, key)
			}
			var out, stderr bytes.Buffer
			code := dispatch("/usr/local/bin/lando", []string{"version"}, helperIO{strings.NewReader(""), &out, &stderr, env})
			want := "Missing " + tc.message + " for host-proxy runLando.\n"
			if code != 127 || stderr.String() != want || out.Len() != 0 {
				t.Fatalf("got %d %q %q", code, stderr.String(), out.String())
			}
		})
	}
}

func TestProxyRequestOverRealTransports(t *testing.T) {
	for _, network := range []string{"tcp", "unix"} {
		t.Run(network, func(t *testing.T) {
			type received struct {
				method, path string
				headers      http.Header
				body         proxyRequest
				err          error
			}
			requests := make(chan received, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body proxyRequest
				err := json.NewDecoder(r.Body).Decode(&body)
				requests <- received{r.Method, r.URL.RequestURI(), r.Header.Clone(), body, err}
				w.WriteHeader(503)
				if _, err := fmt.Fprintln(w, `{"kind":"exit","code":23}`); err != nil {
					t.Error(err)
				}
			}))
			env := proxyEnv()
			if network == "unix" {
				if err := server.Listener.Close(); err != nil {
					t.Fatal(err)
				}
				socket := filepath.Join(t.TempDir(), "proxy.sock")
				listener, err := net.Listen("unix", socket)
				if err != nil {
					t.Fatal(err)
				}
				server.Listener = listener
				env["LANDO_HOST_PROXY_SOCKET"] = socket
			}
			server.Start()
			defer server.Close()
			if network == "tcp" {
				env["LANDO_HOST_PROXY_URL"] = server.URL + "/ignored?query=ignored"
			}
			env["LANDO_HOST_PROXY_CALLER"] = "web"
			env["LANDO_HOST_PROXY_DEPTH"] = "0x10"
			t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
			t.Setenv("ALL_PROXY", "http://127.0.0.1:1")
			var out, stderr bytes.Buffer
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			code := runHostProxy(ctx, []string{"info", "a b", ""}, helperIO{strings.NewReader(""), &out, &stderr, env})
			if code != 23 || stderr.Len() != 0 {
				t.Fatalf("code=%d stderr=%q", code, stderr.String())
			}
			request := <-requests
			if request.err != nil {
				t.Fatal(request.err)
			}
			if request.method != "POST" || request.path != "/runLando" {
				t.Fatalf("request=%+v", request)
			}
			for key, want := range map[string]string{"authorization": "Bearer token", "content-type": "application/json", "x-lando-host-proxy-app": "app", "x-lando-host-proxy-session": "session", "x-lando-host-proxy-caller": "web", "x-lando-host-proxy-depth": "16"} {
				if got := request.headers.Get(key); got != want {
					t.Errorf("%s=%q want %q", key, got, want)
				}
			}
			cwd, err := os.Getwd()
			if err != nil {
				t.Fatal(err)
			}
			if request.body.Tag != "runLando" || !reflect.DeepEqual(request.body.Argv, []string{"info", "a b", ""}) || request.body.Cwd != cwd || request.body.TTY {
				t.Fatalf("body=%+v", request.body)
			}
			if !reflect.DeepEqual(request.body.Env, parsePolicy().filter(env)) {
				t.Fatalf("env=%v", request.body.Env)
			}
		})
	}
}

func TestProxyFrames(t *testing.T) {
	for _, tc := range []struct {
		name, frames, out, stderr string
		code                      int
	}{
		{"streams", "\n{\"kind\":\"stdout\",\"chunk\":\"hello λ\\n\"}\n{\"kind\":\"stderr\",\"chunk\":\"err\"}\n{\"kind\":\"exit\",\"code\":0}\n", "hello λ\n", "err", 0},
		{"error", "{\"kind\":\"error\",\"message\":\"oops\"}\n", "", "oops\n", 1},
		{"last exit wins", "{\"kind\":\"error\",\"message\":\"oops\"}\n{\"kind\":\"exit\",\"code\":7}\n", "", "oops\n", 7},
		{"error overrides exit", "{\"kind\":\"exit\",\"code\":0}\n{\"kind\":\"error\",\"message\":\"oops\"}\n", "", "oops\n", 1},
		{"default", "", "", "", 1},
		{"unknown and wrong types", "null\n[]\n1\n{\"kind\":\"other\"}\n{\"kind\":\"stdout\",\"chunk\":3}\n{\"kind\":\"error\",\"message\":null}\n{\"kind\":\"exit\",\"code\":null}\n", "", "", 1},
		{"invalid", "not json\n{\"kind\":\"exit\",\"code\":0}\n", "", "Invalid host-proxy frame: invalid JSON\n", 1},
		{"unterminated ignored", "{\"kind\":\"exit\",\"code\":0}", "", "", 1},
		{"large line", "{\"kind\":\"stdout\",\"chunk\":\"" + strings.Repeat("x", 70000) + "\"}\n", strings.Repeat("x", 70000), "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, stderr bytes.Buffer
			code, err := readProxyFrames(&singleByteReader{strings.NewReader(tc.frames)}, helperIO{stdout: &out, stderr: &stderr})
			if err != nil || code != tc.code || out.String() != tc.out || stderr.String() != tc.stderr {
				t.Fatalf("code=%d err=%v output lengths=%d/%d stderr=%q", code, err, out.Len(), len(tc.out), stderr.String())
			}
		})
	}
}

type singleByteReader struct{ io.Reader }

func (r *singleByteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:min(1, len(p))]) }

func TestProxyTransportErrors(t *testing.T) {
	for _, target := range []string{"", "http://[bad", "http://127.0.0.1:0"} {
		t.Run(target, func(t *testing.T) {
			env := proxyEnv()
			env["LANDO_HOST_PROXY_URL"] = target
			var out, stderr bytes.Buffer
			code := runHostProxy(context.Background(), nil, helperIO{stdout: &out, stderr: &stderr, env: env})
			if code != 127 || stderr.Len() == 0 || !strings.HasSuffix(stderr.String(), "\n") {
				t.Fatalf("code=%d stderr=%q", code, stderr.String())
			}
		})
	}
}

func TestCharDeviceIsNotTerminal(t *testing.T) {
	file, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if isTerminal(file) {
		t.Fatal("/dev/null is not a terminal")
	}
}

func TestPseudoTerminalIsTerminal(t *testing.T) {
	file, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if !isTerminal(file) {
		t.Fatal("pseudo-terminal must pass TCGETS")
	}
}
