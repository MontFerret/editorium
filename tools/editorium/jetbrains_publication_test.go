package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestJetBrainsGitHubReleaseLookup(t *testing.T) {
	m := releaseMetadata{Tag: "jetbrains/v0.1.0", Title: "Ferret JetBrains 0.1.0", Assets: jetbrainsReleaseAssetNames("0.1.0")}
	body := fmt.Sprintf(`{"tag_name":%q,"name":%q,"assets":[{"name":%q},{"name":%q}]}`, m.Tag, m.Title, m.Assets[0], m.Assets[1])
	for _, tc := range []struct {
		code, repo int
		body, want string
	}{
		{404, 200, "[]", "create"}, {404, 200, "[" + strings.Replace(body, `"name":`, `"draft":true,"name":`, 1) + "]", ""}, {404, 404, "", ""}, {403, 200, "", ""}, {500, 200, "", ""},
		{200, 200, body, "noop"}, {200, 200, strings.Replace(body, m.Assets[1], "other", 1), ""},
		{200, 200, strings.Replace(body, `"name":`, `"draft":true,"name":`, 1), ""},
		{200, 200, strings.Replace(body, m.Title, "other", 1), ""}, {200, 200, "malformed", ""},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Error("missing GitHub bearer auth")
			}
			if r.URL.Path == "/repo/releases" {
				w.WriteHeader(tc.repo)
				fmt.Fprint(w, tc.body)
				return
			}
			if r.URL.Path != "/repo/releases/tags/"+m.Tag {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			w.WriteHeader(tc.code)
			fmt.Fprint(w, tc.body)
		}))
		got, err := jetbrainsGitHubState(context.Background(), srv.URL+"/repo", "test-token", m)
		srv.Close()
		if err != nil && strings.Contains(tc.body, m.Tag) && (tc.code == http.StatusOK || tc.code == http.StatusNotFound && tc.repo == http.StatusOK) {
			for _, asset := range m.Assets {
				if !strings.Contains(err.Error(), asset) {
					t.Fatalf("missing recovery asset %s: %v", asset, err)
				}
			}
		}
		if got != tc.want || (err == nil) != (tc.want != "") {
			t.Fatalf("GET %d %s = %s, %v", tc.code, tc.body, got, err)
		}
	}
}

func TestJetBrainsMarketplacePolicy(t *testing.T) {
	for _, tc := range []struct {
		eligible, enabled, recovery, created bool
		attempt                              string
		send                                 bool
	}{
		{true, true, false, true, "1", true}, {false, true, false, true, "1", false}, {true, false, false, true, "1", false},
		{true, true, false, false, "1", false}, {true, true, false, true, "2", false},
		{true, true, true, false, "1", true}, {true, true, true, false, "2", false},
	} {
		got, reason := marketplaceUploadPolicy(releaseMetadata{MarketplaceEligible: tc.eligible}, tc.enabled, tc.recovery, tc.created, tc.attempt)
		if got != tc.send || (!got && reason == "") {
			t.Fatalf("policy %+v: %v %q", tc, got, reason)
		}
	}
}

func TestJetBrainsMarketplaceSubmission(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ferret-jetbrains-0.1.0-signed.zip")
	contents := []byte("selected signed bytes\x00\xff")
	writeTestFile(t, path, contents, 0o644)
	for _, tc := range []struct {
		code int
		want string
	}{
		{200, ""}, {401, "authentication"}, {403, "authentication"}, {409, "vendor dashboard"},
		{400, "vendor dashboard"}, {502, "vendor dashboard"}, {0, "outcome unknown"},
	} {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer disposable" || r.FormValue("xmlId") != jetbrainsPluginID || r.FormValue("channel") != "" {
				t.Error("unexpected upload parameters")
			}
			f, h, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer f.Close()
			data, err := io.ReadAll(f)
			if err != nil || !bytes.Equal(contents, data) || h.Filename != filepath.Base(path) {
				t.Error("changed file in upload")
			}
			if tc.code == 0 {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				conn.Close()
				return
			}
			w.WriteHeader(tc.code)
			if tc.code == 409 || tc.code == 400 {
				fmt.Fprint(w, "Version already exists")
			}
		}))
		err := uploadMarketplace(context.Background(), srv.URL, "disposable", path)
		srv.Close()
		if calls.Load() != 1 || (tc.want == "" && err != nil) || (tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want))) {
			t.Fatalf("POST %d: %v (%d attempts)", tc.code, err, calls.Load())
		}
	}
	if err := uploadMarketplace(context.Background(), "", "", "missing"); err == nil || !strings.Contains(err.Error(), "TOKEN") {
		t.Fatalf("missing token: %v", err)
	}
}

func TestJetBrainsReleaseAssetSet(t *testing.T) {
	dir := t.TempDir()
	names := jetbrainsReleaseAssetNames("0.1.0")
	for _, name := range names {
		writeTestFile(t, filepath.Join(dir, name), []byte("asset"), 0o644)
	}
	if _, err := validateReleaseAssets(dir, names); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, names[0]), filepath.Join(dir, "ferret-jetbrains-0.1.0.zip")); err != nil {
		t.Fatal(err)
	}
	if _, err := validateReleaseAssets(dir, names); err == nil {
		t.Fatal("accepted unsigned substitute")
	}
}

func TestJetBrainsPublicationRechecksReleaseAndTag(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a Unix gh executable fixture")
	}
	f := newReleaseGitFixture(t)
	const tag = "jetbrains/v0.1.0"
	ref := "refs/tags/" + tag
	f.git(t, "tag", "-a", tag, "-m", "release")
	f.git(t, "push", "origin", ref)
	m, err := metadataFromTag(f.work, tag)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, m.Assets[0])
	writeTestFile(t, path, []byte("qualified signed bytes"), 0o644)
	sum, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path+".sha256", []byte(sum+"  "+m.Assets[0]+"\n"), 0o644)
	t.Setenv("GH_TOKEN", "test-token")
	var published atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/releases" {
			fmt.Fprint(w, "[]")
			return
		}
		if !published.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprintf(w, `{"tag_name":%q,"name":%q,"assets":[{"name":%q},{"name":%q}]}`, m.Tag, m.Title, m.Assets[0], m.Assets[1])
	}))
	defer srv.Close()
	if action, err := jetbrainsGitHubState(context.Background(), srv.URL, "test-token", m); err != nil || action != "create" {
		t.Fatalf("preflight: %s %v", action, err)
	}
	// Capture gh's arguments and both local input files, without contacting GitHub.
	bin := t.TempDir()
	t.Setenv("FAKE_GH_OUTPUT", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	script := `#!/bin/sh
set -eu
test "$1" = release && test "$2" = create
printf '%s\n' "$@" > "$FAKE_GH_OUTPUT/args"
cp "$4" "$FAKE_GH_OUTPUT/upload.zip"
cp "$5" "$FAKE_GH_OUTPUT/upload.sha256"
`
	writeTestFile(t, filepath.Join(bin, "gh"), []byte(script), 0o755)
	if created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m); err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	captured := os.Getenv("FAKE_GH_OUTPUT")
	assertTestContents(t, filepath.Join(captured, "upload.zip"), "qualified signed bytes")
	assertTestContents(t, filepath.Join(captured, "upload.sha256"), sum+"  "+m.Assets[0]+"\n")
	args, err := os.ReadFile(filepath.Join(captured, "args"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "\n"+tag+"\n") || !strings.Contains(string(args), "\n--verify-tag\n") {
		t.Fatalf("unexpected gh command: %s", args)
	}
	writeTestFile(t, filepath.Join(bin, "gh"), []byte("#!/bin/sh\nexit 83\n"), 0o755)
	// A release appeared after preflight. Reuse the GitHub assets and never invoke gh create.
	published.Store(true)
	if created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m); err != nil || created {
		t.Fatalf("concurrent publication: %v %v", created, err)
	}
	published.Store(false)
	if created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, "other", m); err == nil || created || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("bad handoff: %v", err)
	}
	bareGit(t, f.remote, "update-ref", "-d", ref)
	if created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m); err == nil || created || !strings.Contains(err.Error(), "remote annotated tag") {
		t.Fatalf("tag recheck: %v", err)
	}
}
