package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

const marketplaceTestTag = "vscode/v0.1.0"

func TestVSCodeMarketplaceVerifiesQualifiedAndRecoveredPackages(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	ref := "refs/tags/" + marketplaceTestTag
	fixture.git(t, "tag", "-m", "original release", marketplaceTestTag)
	fixture.git(t, "push", "origin", ref)
	qualified := t.TempDir()
	release, packages := marketplaceReleaseFixture(t, qualified, nil)
	api, downloads := serveMarketplaceRelease(t, release, packages, nil)

	if err := prepareVSCodeMarketplaceAssets(t.Context(), fixture.work, api.URL, "test-token", marketplaceTestTag, qualified, false, api.Client()); err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 0 {
		t.Fatal("tag push downloaded packages instead of verifying its qualified assets")
	}

	fixture.git(t, "tag", "-d", marketplaceTestTag)
	writeVSCodePackageManifest(t, fixture.work, "0.2.0")
	fixture.git(t, "add", "extensions/vscode/package.json")
	fixture.git(t, "commit", "-m", "newer version on main")
	localRefs := fixture.git(t, "show-ref")
	remoteRefs := bareGit(t, fixture.remote, "show-ref")
	for _, suffix := range []string{"first-attempt", "retry"} {
		recovered := filepath.Join(t.TempDir(), suffix)
		if err := prepareVSCodeMarketplaceAssets(t.Context(), fixture.work, api.URL, "test-token", marketplaceTestTag, recovered, true, api.Client()); err != nil {
			t.Fatal(err)
		}
		for _, asset := range release.Assets {
			digest, err := sha256File(filepath.Join(recovered, asset.Name))
			if err != nil || "sha256:"+digest != asset.Digest {
				t.Fatalf("recovered %s has digest %q, err=%v", asset.Name, digest, err)
			}
		}
	}
	if downloads.Load() != 2*int32(len(vscodeTargets)) {
		t.Fatalf("recovery downloaded %d assets across two attempts", downloads.Load())
	}
	if fixture.git(t, "show-ref") != localRefs || bareGit(t, fixture.remote, "show-ref") != remoteRefs {
		t.Fatal("recovery changed release refs")
	}
	if manifest, err := readVSCodeManifest(fixture.work); err != nil || manifest.Version != "0.2.0" {
		t.Fatalf("recovery changed the trusted checkout: %#v, %v", manifest, err)
	}
}

func TestVSCodeMarketplaceRejectsIneligibleAndConflictingReleases(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	fixture.git(t, "tag", "-m", "original release", marketplaceTestTag)
	fixture.git(t, "push", "origin", "refs/tags/"+marketplaceTestTag)
	original, packages := marketplaceReleaseFixture(t, t.TempDir(), nil)
	for _, test := range []struct {
		name   string
		tag    string
		change func(*vscodeMarketplaceRelease)
		want   string
	}{
		{name: "missing tag", tag: "vscode/v0.2.0", want: "missing remote annotated tag"},
		{name: "other integration", tag: "jetbrains/v0.1.0", want: "exact stable VS Code"},
		{name: "version suffix", tag: "vscode/v0.1.0-rc.1", want: "exact stable VS Code"},
		{name: "build metadata", tag: "vscode/v0.1.0+build.1", want: "exact stable VS Code"},
		{name: "invalid tag", tag: "vscode/v0.01.0", want: "exact stable VS Code"},
		{name: "missing release", change: func(r *vscodeMarketplaceRelease) { *r = vscodeMarketplaceRelease{} }, want: "HTTP 404"},
		{name: "draft", change: func(r *vscodeMarketplaceRelease) { r.Draft = true }, want: "already be published"},
		{name: "prerelease metadata", change: func(r *vscodeMarketplaceRelease) { r.Prerelease = true }, want: "conflicts"},
		{name: "wrong title", change: func(r *vscodeMarketplaceRelease) { r.Name = "Other release" }, want: "conflicts"},
		{name: "wrong tag", change: func(r *vscodeMarketplaceRelease) { r.Tag = "vscode/v0.2.0" }, want: "does not match"},
		{name: "missing asset", change: func(r *vscodeMarketplaceRelease) { r.Assets = r.Assets[1:] }, want: "conflicts"},
		{name: "unexpected asset", change: func(r *vscodeMarketplaceRelease) { r.Assets[0].Name = "foreign.vsix" }, want: "conflicts"},
		{name: "duplicate asset", change: func(r *vscodeMarketplaceRelease) { r.Assets[0] = r.Assets[1] }, want: "conflicts"},
		{name: "unfinished upload", change: func(r *vscodeMarketplaceRelease) { r.Assets[0].State = "starter" }, want: "must be uploaded"},
		{name: "missing digest", change: func(r *vscodeMarketplaceRelease) { r.Assets[0].Digest = "" }, want: "SHA-256 digest"},
	} {
		t.Run(test.name, func(t *testing.T) {
			release := original
			release.Assets = slices.Clone(release.Assets)
			if test.change != nil {
				test.change(&release)
			}
			tag := test.tag
			if tag == "" {
				tag = marketplaceTestTag
			}
			api, downloads := serveMarketplaceRelease(t, release, packages, nil)
			directory := filepath.Join(t.TempDir(), "recovery")
			err := prepareVSCodeMarketplaceAssets(t.Context(), fixture.work, api.URL, "test-token", tag, directory, true, api.Client())
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if _, err := os.Stat(directory); !os.IsNotExist(err) || downloads.Load() != 0 {
				t.Fatalf("recovery wrote files or downloaded assets for an invalid release: %v, downloads=%d", err, downloads.Load())
			}
		})
	}
}

func TestVSCodeMarketplaceRejectsConflictingAssetBytes(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	fixture.git(t, "tag", "-m", "original release", marketplaceTestTag)
	fixture.git(t, "push", "origin", "refs/tags/"+marketplaceTestTag)
	for _, test := range []struct {
		name, want string
		change     func(map[string]testZipEntry)
	}{
		{name: "digest mismatch", want: "SHA-256 digest does not match"},
		{name: "wrong target", want: "target platform", change: func(entries map[string]testZipEntry) {
			entries["extension.vsixmanifest"] = testZipEntry{[]byte(testVSIXManifest("linux-x64")), 0o100644}
		}},
		{name: "wrong version", want: "manifest identity", change: func(entries map[string]testZipEntry) {
			entry := entries["extension/package.json"]
			entry.contents = []byte(strings.ReplaceAll(string(entry.contents), "0.1.0", "0.2.0"))
			entries["extension/package.json"] = entry
		}},
		{name: "marketplace prerelease", want: "marked as a Marketplace prerelease", change: func(entries map[string]testZipEntry) {
			entry := entries["extension.vsixmanifest"]
			entry.contents = []byte(strings.ReplaceAll(string(entry.contents), "</Metadata>", `<Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/></Properties></Metadata>`))
			entries["extension.vsixmanifest"] = entry
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			qualified := t.TempDir()
			release, packages := marketplaceReleaseFixture(t, qualified, test.change)
			if test.change == nil {
				release.Assets[0].Digest = "sha256:" + strings.Repeat("0", 64)
			}
			api, _ := serveMarketplaceRelease(t, release, packages, nil)
			for _, download := range []bool{false, true} {
				directory := qualified
				if download {
					directory = filepath.Join(t.TempDir(), "recovery")
				}
				err := prepareVSCodeMarketplaceAssets(t.Context(), fixture.work, api.URL, "test-token", marketplaceTestTag, directory, download, api.Client())
				if err == nil || !strings.Contains(err.Error(), test.want) {
					t.Fatalf("download=%t: error = %v, want %q", download, err, test.want)
				}
				if _, err := os.Stat(directory); download && !os.IsNotExist(err) {
					t.Fatalf("failed recovery left an asset directory: %v", err)
				}
			}
		})
	}
}

func TestVSCodeMarketplaceDetectsTagMovedDuringRecovery(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	ref := "refs/tags/" + marketplaceTestTag
	fixture.git(t, "tag", "-m", "original release", marketplaceTestTag)
	fixture.git(t, "tag", "-m", "replacement tag object", "replacement")
	fixture.git(t, "push", "origin", ref, "refs/tags/replacement")
	replacement := fixture.git(t, "rev-parse", "refs/tags/replacement")
	release, packages := marketplaceReleaseFixture(t, t.TempDir(), nil)
	api, _ := serveMarketplaceRelease(t, release, packages, func() {
		cmd := exec.Command("git", "--git-dir", fixture.remote, "update-ref", ref, replacement)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("move tag: %v (%s)", err, output)
		}
	})
	directory := filepath.Join(t.TempDir(), "recovery")
	err := prepareVSCodeMarketplaceAssets(t.Context(), fixture.work, api.URL, "test-token", marketplaceTestTag, directory, true, api.Client())
	if err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("moved tag error = %v", err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("failed recovery left an asset directory: %v", err)
	}
}

func marketplaceReleaseFixture(t *testing.T, directory string, change func(map[string]testZipEntry)) (vscodeMarketplaceRelease, map[int64][]byte) {
	t.Helper()
	release := vscodeMarketplaceRelease{Tag: marketplaceTestTag, Name: "Ferret VS Code 0.1.0"}
	packages := make(map[int64][]byte)
	for i, target := range vscodeTargets {
		name := vsixFilename("0.1.0", target)
		path := filepath.Join(directory, name)
		var edit func(map[string]testZipEntry)
		if i == 0 {
			edit = change
		}
		writeVSIX(t, path, target, []byte("fixture daemon"), edit)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		id := int64(i + 1)
		release.Assets = append(release.Assets, vscodeMarketplaceAsset{
			ID: id, Name: name, State: "uploaded", Size: int64(len(data)), Digest: fmt.Sprintf("sha256:%x", sha256.Sum256(data)),
		})
		packages[id] = data
	}
	return release, packages
}

func serveMarketplaceRelease(t *testing.T, release vscodeMarketplaceRelease, packages map[int64][]byte, afterInspection func()) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var downloads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		if r.URL.EscapedPath() == "/tags/vscode%2Fv0.1.0" && r.Header.Get("Accept") == "application/vnd.github+json" && release.Tag != "" {
			if afterInspection != nil {
				afterInspection()
			}
			if err := json.NewEncoder(w).Encode(release); err != nil {
				t.Error(err)
			}
			return
		}
		if rawID, ok := strings.CutPrefix(r.URL.Path, "/assets/"); ok && r.Header.Get("Accept") == "application/octet-stream" {
			id, err := strconv.ParseInt(rawID, 10, 64)
			if data, exists := packages[id]; err == nil && exists {
				downloads.Add(1)
				if _, err := w.Write(data); err != nil {
					t.Error(err)
				}
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	return server, &downloads
}
