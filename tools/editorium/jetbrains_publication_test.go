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
	stable := releaseMetadata{MarketplaceEligible: true}
	for _, tc := range []struct {
		name                    string
		metadata                releaseMetadata
		enablement              marketplaceEnablement
		recovery, created       bool
		attempt, createdAttempt string
		reason                  string
	}{
		{"first attempt", stable, marketplaceEnabled, false, true, "1", "1", ""},
		{"rerun after qualification failed", stable, marketplaceEnabled, false, true, "2", "2", ""},
		{"rerun after signing failed", stable, marketplaceEnabled, false, true, "3", "3", ""},
		{"rerun after publication failed", stable, marketplaceEnabled, false, true, "2", "2", ""},
		{"existing release on full rerun", stable, marketplaceEnabled, false, false, "2", "", "Explicit recovery required"},
		{"retained output after accepted submission", stable, marketplaceEnabled, false, true, "2", "1", "Explicit recovery required"},
		{"retained output after unknown submission", stable, marketplaceEnabled, false, true, "3", "2", "Explicit recovery required"},
		{"missing creation attempt", stable, marketplaceEnabled, false, true, "2", "", "Explicit recovery required"},
		{"missing current attempt", stable, marketplaceEnabled, false, true, "", "", "Explicit recovery required"},
		{"attempt without creation", stable, marketplaceEnabled, false, false, "2", "2", "Explicit recovery required"},
		{"fresh confirmed recovery", stable, marketplaceEnabled, true, false, "1", "", ""},
		{"reused recovery confirmation", stable, marketplaceEnabled, true, false, "2", "", "Explicit recovery required"},
		{"disabled", stable, marketplaceDisabled, false, true, "2", "2", "publication disabled"},
		{"initial listing", stable, marketplaceSetupPending, false, true, "2", "2", "Initial Marketplace listing setup required"},
		{"prerelease", releaseMetadata{Prerelease: true}, marketplaceEnabled, false, true, "2", "2", "GitHub-only prerelease"},
		{"build metadata", releaseMetadata{}, marketplaceEnabled, false, true, "2", "2", "GitHub-only version"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upload, reason := marketplaceUploadPolicy(tc.metadata, tc.enablement, tc.recovery, tc.created, tc.attempt, tc.createdAttempt)
			if upload != (tc.reason == "") || (upload && reason != "") || !strings.Contains(reason, tc.reason) {
				t.Fatalf("policy: upload=%v reason=%q", upload, reason)
			}
		})
	}
}

func TestJetBrainsMarketplaceEnablement(t *testing.T) {
	for _, tc := range []struct {
		config string
		want   marketplaceEnablement
	}{
		{"", marketplaceSetupPending},
		{"false", marketplaceDisabled},
		{"true", marketplaceEnabled},
	} {
		t.Setenv("JB_MARKETPLACE_ENABLED", tc.config)
		got, err := jetBrainsMarketplaceEnablement()
		if err != nil || got != tc.want {
			t.Fatalf("enablement %q: %v, %v", tc.config, got, err)
		}
	}
	t.Setenv("JB_MARKETPLACE_ENABLED", "invalid")
	if _, err := jetBrainsMarketplaceEnablement(); err == nil {
		t.Fatal("accepted invalid enablement")
	}
}

func TestJetBrainsPublishedAssetIDs(t *testing.T) {
	m := releaseMetadata{Tag: "jetbrains/v0.1.0", Title: "Ferret JetBrains 0.1.0", Assets: jetbrainsReleaseAssetNames("0.1.0")}
	for _, tc := range []struct {
		name  string
		draft bool
		zipID int
		ok    bool
	}{
		{"published", false, 24, true},
		{"draft", true, 24, false},
		{"missing ID", false, 0, false},
		{"duplicate ID", false, 7, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/releases/tags/"+m.Tag {
					t.Errorf("unexpected release lookup %s", r.URL.Path)
				}
				fmt.Fprintf(w, `{"tag_name":%q,"name":%q,"draft":%t,"assets":[{"id":7,"name":%q},{"id":%d,"name":%q}]}`,
					m.Tag, m.Title, tc.draft, m.Assets[1], tc.zipID, m.Assets[0])
			}))
			defer srv.Close()
			ids, err := jetbrainsPublishedAssetIDs(context.Background(), srv.URL, "test-token", m)
			if (err == nil) != tc.ok || tc.ok && ids != [2]int64{24, 7} {
				t.Fatalf("published asset IDs: %v, %v", ids, err)
			}
		})
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
	var publishMode atomic.Value
	publishMode.Store("confirmed")
	var patches atomic.Int32
	release := fmt.Sprintf(`{"id":17,"tag_name":%q,"name":%q,"assets":[{"name":%q},{"name":%q}]}`, m.Tag, m.Title, m.Assets[0], m.Assets[1])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			patches.Add(1)
			body, err := io.ReadAll(r.Body)
			if err != nil || r.URL.Path != "/releases/17" || string(body) != `{"draft":false,"make_latest":"false"}` {
				t.Errorf("unexpected draft publication: %s %s %v", r.URL.Path, body, err)
			}
			switch publishMode.Load() {
			case "lost response":
				published.Store(true)
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				conn.Close()
			case "unconfirmed":
				w.WriteHeader(http.StatusServiceUnavailable)
			case "wrong release":
				published.Store(true)
				fmt.Fprint(w, strings.Replace(release, `"id":17`, `"id":18`, 1))
			default:
				published.Store(true)
				fmt.Fprint(w, release)
			}
			return
		case http.MethodGet:
		default:
			t.Errorf("unexpected GitHub mutation: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/releases" {
			fmt.Fprint(w, "[]")
			return
		}
		if !published.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprint(w, release)
	}))
	defer srv.Close()
	if action, err := jetbrainsGitHubState(context.Background(), srv.URL, "test-token", m); err != nil || action != "create" {
		t.Fatalf("preflight: %s %v", action, err)
	}
	// Capture gh's arguments and both local input files, without contacting GitHub.
	bin := t.TempDir()
	t.Setenv("FAKE_GH_OUTPUT", t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	draftView := fmt.Sprintf(`{"databaseId":17,"url":"https://github.com/test/test/releases/tag/untagged-fixture","tagName":%q,"name":%q,"isDraft":true,"assets":[{"name":%q},{"name":%q}]}`,
		m.Tag, m.Title, m.Assets[0], m.Assets[1])
	t.Setenv("FAKE_DRAFT_VIEW", draftView)
	script := `#!/bin/sh
set -eu
test "$1" = release
case "$2" in
  create)
    printf '%s\n' "$@" > "$FAKE_GH_OUTPUT/args"
    cp "$4" "$FAKE_GH_OUTPUT/upload.zip"
    cp "$5" "$FAKE_GH_OUTPUT/upload.sha256"
    printf '%s\n' 'https://github.com/test/test/releases/tag/untagged-fixture'
    ;;
  view) printf '%s\n' "$FAKE_DRAFT_VIEW" ;;
  *) exit 83 ;;
esac
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
	if !strings.Contains(string(args), "\n"+tag+"\n") || !strings.Contains(string(args), "\n--verify-tag\n") || !strings.Contains(string(args), "\n--draft\n") {
		t.Fatalf("unexpected gh command: %s", args)
	}
	if patches.Load() != 1 {
		t.Fatalf("PATCH attempts: %d", patches.Load())
	}
	for _, mode := range []string{"lost response", "wrong release", "unconfirmed"} {
		t.Run(mode, func(t *testing.T) {
			published.Store(false)
			publishMode.Store(mode)
			patches.Store(0)
			created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m)
			if created || (err != nil) != (mode == "unconfirmed") || patches.Load() != 1 {
				t.Fatalf("publish: created=%t err=%v PATCH attempts=%d", created, err, patches.Load())
			}
		})
	}
	t.Run("concurrent draft", func(t *testing.T) {
		published.Store(false)
		patches.Store(0)
		t.Setenv("FAKE_DRAFT_VIEW", strings.Replace(draftView, "untagged-fixture", "untagged-other", 1))
		created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m)
		if created || err == nil || !strings.Contains(err.Error(), "newly created draft") || patches.Load() != 0 {
			t.Fatalf("concurrent draft: created=%v err=%v PATCH attempts=%d", created, err, patches.Load())
		}
	})
	writeTestFile(t, filepath.Join(bin, "gh"), []byte("#!/bin/sh\nexit 83\n"), 0o755)
	// A release appeared after preflight. Reuse the GitHub assets and never invoke gh create.
	published.Store(true)
	if created, err := publishJetBrainsRelease(context.Background(), f.work, srv.URL, dir, sum, m); err != nil || created {
		t.Fatalf("concurrent publication: %v %v", created, err)
	}
	if err := requireJetBrainsReleaseAbsent(context.Background(), srv.URL, "test-token", m); err == nil || !strings.Contains(err.Error(), "Re-run all jobs") {
		t.Fatalf("stale preflight did not block qualification: %v", err)
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

func TestJetBrainsMarketplaceUploadRechecksVerifiedRelease(t *testing.T) {
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
	writeTestFile(t, path, []byte("verified release bytes"), 0o644)
	sum, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GH_TOKEN", "github-token")
	t.Setenv("JB_MARKETPLACE_TOKEN", "marketplace-token")
	var missing atomic.Bool
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/marketplace" {
			posts.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/releases/tags/"+tag {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if missing.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprintf(w, `{"tag_name":%q,"name":%q,"assets":[{"name":%q},{"name":%q}]}`, m.Tag, m.Title, m.Assets[0], m.Assets[1])
	}))
	defer srv.Close()

	ctx := context.Background()
	if err := submitVerifiedJetBrainsArchive(ctx, f.work, srv.URL, srv.URL+"/marketplace", dir, sum, m); err != nil || posts.Load() != 1 {
		t.Fatalf("verified upload: %v (%d POSTs)", err, posts.Load())
	}
	posts.Store(0)
	if err := submitVerifiedJetBrainsArchive(ctx, f.work, srv.URL, srv.URL+"/marketplace", dir, "wrong", m); err == nil || !strings.Contains(err.Error(), "verified SHA-256") || posts.Load() != 0 {
		t.Fatalf("changed archive: %v (%d POSTs)", err, posts.Load())
	}
	missing.Store(true)
	if err := submitVerifiedJetBrainsArchive(ctx, f.work, srv.URL, srv.URL+"/marketplace", dir, sum, m); err == nil || !strings.Contains(err.Error(), "cannot verify published GitHub Release") || posts.Load() != 0 {
		t.Fatalf("missing release: %v (%d POSTs)", err, posts.Load())
	}
	missing.Store(false)
	bareGit(t, f.remote, "update-ref", "-d", ref)
	if err := submitVerifiedJetBrainsArchive(ctx, f.work, srv.URL, srv.URL+"/marketplace", dir, sum, m); err == nil || !strings.Contains(err.Error(), "remote annotated tag") || posts.Load() != 0 {
		t.Fatalf("changed tag: %v (%d POSTs)", err, posts.Load())
	}
}
