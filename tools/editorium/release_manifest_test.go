package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseManifestEditsPreserveUnrelatedBytes(t *testing.T) {
	root := t.TempDir()
	manifest := "{\r\n\t\"version\" : \"0.1.0\", \"dependencies\": {\"version\": \"0.1.0\"}\r\n}\r\n"
	lock := "{\n  \"version\": \"0.0.9\", \"lockfileVersion\": 3,\n  \"packages\": { \"\": {\"version\":\"0.1.0\"}, \"node_modules/test\": {\"version\": \"0.1.0\", \"integrity\": \"unchanged\"}}\n}\n"
	writeTestFile(t, filepath.Join(root, "extensions/vscode/package.json"), []byte(manifest), 0o644)
	writeTestFile(t, filepath.Join(root, "extensions/vscode/package-lock.json"), []byte(lock), 0o644)
	edits, err := planVSCodeReleaseManifests(root, "0.1.0", "0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	wantManifest := strings.Replace(manifest, `"0.1.0"`, `"0.2.0"`, 1)
	wantLock := strings.Replace(strings.Replace(lock, `"0.0.9"`, `"0.2.0"`, 1), `"0.1.0"`, `"0.2.0"`, 1)
	if string(edits[0].after) != wantManifest || string(edits[1].after) != wantLock {
		t.Fatalf("edits changed unrelated content: %+v", edits)
	}
	for _, edit := range edits {
		actual, err := os.ReadFile(filepath.Join(root, edit.path))
		if err != nil || !bytes.Equal(actual, edit.before) {
			t.Fatal("planning modified a manifest")
		}
	}
	properties := "# properties\r\nother=0.1.0\r\n  pluginVersion =  0.1.0  \r\nlast = keep\r\n"
	writeTestFile(t, filepath.Join(root, jetbrainsVersionSource), []byte(properties), 0o644)
	edits, err = planJetBrainsReleaseManifests(root, "0.1.0", "0.2.0-rc.1")
	if err != nil || string(edits[0].after) != strings.Replace(properties, "  0.1.0  ", "  0.2.0-rc.1  ", 1) {
		t.Fatalf("property edits: %+v %v", edits, err)
	}
}

func TestReleaseJSONVersionsRejectAmbiguousInputs(t *testing.T) {
	for _, input := range []string{
		`{"version":"1.0.0","version":"2.0.0"}`, `{"version":1}`, `{"version":null}`, `{}`, `[]`,
		`{"version":"1.0.0","packages":{"":{"version":"1.0.0","version":"2.0.0"}}}`,
		`{"version":"1.0.0","packages":[]}`, `{"version":"1.0.0","packages":{}}`,
		`{"version":"1.0.0","packages\u0000\u0000version":"1.0.0"}`,
	} {
		if _, _, err := replaceReleaseJSONVersions([]byte(input), map[string]string{"/version": "2.0.0", "/packages//version": "2.0.0"}); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
}

func TestVSCodeReleaseLockfileSupportsNpmCI(t *testing.T) {
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm unavailable")
	}
	t.Setenv("npm_config_offline", "true")
	t.Setenv("npm_config_audit", "false")
	t.Setenv("npm_config_fund", "false")
	t.Setenv("npm_config_cache", t.TempDir())
	f := newReleaseGitFixture(t)
	if err := runReleaseWithValidator(t.Context(), f.work, "vscode", "patch", func(ctx context.Context, root, _ string) error { return installVSCodeReleaseDependencies(ctx, root) }); err != nil {
		t.Fatal(err)
	}
}
