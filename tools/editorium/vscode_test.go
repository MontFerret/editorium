package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExtensionCatalogSelectionAndUnknownIntegrations(t *testing.T) {
	names := extensionNames()
	if len(names) != 1 || names[0] != "vscode" {
		t.Fatalf("extensionNames() = %v", names)
	}
	if err := validateExtensions(nil); err != nil {
		t.Fatal(err)
	}
	if err := validateExtensions([]string{"vscode"}); err != nil {
		t.Fatal(err)
	}
	for _, names := range [][]string{{"unknown"}, {"vscode", "vscode"}} {
		err := validateExtensions(names)
		if err == nil || (names[0] == "unknown" && (!strings.Contains(err.Error(), "Available integrations:\n  vscode") || !strings.Contains(err.Error(), "Usage:"))) {
			t.Fatalf("validateExtensions(%v) = %v", names, err)
		}
	}
}

func TestVSCodeTargetMatrixMappingsAndFilenames(t *testing.T) {
	expected := []struct {
		id, platform, architecture, artifact, archiveType, binary, runner string
		unix                                                              bool
	}{
		{"darwin-arm64", "darwin", "arm64", "ferretd_darwin_arm64.tar.gz", "tar.gz", "ferretd", "macos-14", true},
		{"darwin-x64", "darwin", "amd64", "ferretd_darwin_x86_64.tar.gz", "tar.gz", "ferretd", "macos-15-intel", true},
		{"linux-x64", "linux", "amd64", "ferretd_linux_x86_64.tar.gz", "tar.gz", "ferretd", "ubuntu-24.04", true},
		{"linux-arm64", "linux", "arm64", "ferretd_linux_arm64.tar.gz", "tar.gz", "ferretd", "ubuntu-24.04-arm", true},
		{"win32-x64", "windows", "amd64", "ferretd_windows_x86_64.zip", "zip", "ferretd.exe", "windows-2025", false},
		{"win32-arm64", "windows", "arm64", "ferretd_windows_arm64.zip", "zip", "ferretd.exe", "windows-11-arm", false},
	}
	if len(vscodeTargets) != len(expected) {
		t.Fatalf("target count = %d", len(vscodeTargets))
	}
	for index, want := range expected {
		got := vscodeTargets[index]
		if got.ID != want.id || got.Platform != want.platform || got.Architecture != want.architecture || got.Artifact != want.artifact || got.ArchiveType != want.archiveType || got.BinaryName != want.binary || got.Runner != want.runner || got.Unix != want.unix {
			t.Fatalf("target %d = %#v, want %#v", index, got, want)
		}
		if filename := vsixFilename("0.2.0-beta.1", got); filename != "ferret-vscode-0.2.0-beta.1-"+want.id+".vsix" {
			t.Fatalf("vsixFilename() = %s", filename)
		}
		resolved, err := resolveTarget(want.id)
		if err != nil || resolved.ID != want.id {
			t.Fatalf("resolveTarget(%s) = %#v, %v", want.id, resolved, err)
		}
		detected, err := detectHostTarget(want.platform, want.architecture)
		if err != nil || detected.ID != want.id {
			t.Fatalf("detectHostTarget(%s, %s) = %#v, %v", want.platform, want.architecture, detected, err)
		}
	}
	if _, err := resolveTarget("linux-armhf"); err == nil || !strings.Contains(err.Error(), strings.Join(targetIDs(), ", ")) {
		t.Fatalf("resolveTarget unknown error = %v", err)
	}
	if _, err := detectHostTarget("freebsd", "amd64"); err == nil {
		t.Fatal("detectHostTarget accepted an unsupported host")
	}
	matrix := struct {
		Include []vscodeTarget `json:"include"`
	}{Include: vscodeTargets}
	encoded, err := json.Marshal(matrix)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string][]map[string]string
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for index, entry := range decoded["include"] {
		if len(entry) != 2 || entry["target"] != expected[index].id || entry["runner"] != expected[index].runner {
			t.Fatalf("matrix entry %d = %#v", index, entry)
		}
	}
}

func TestSelectedTargetHonorsTargetEnvironment(t *testing.T) {
	t.Setenv("TARGET", "linux-arm64")
	target, err := selectedTarget()
	if err != nil || target.ID != "linux-arm64" {
		t.Fatalf("selectedTarget() = %#v, %v", target, err)
	}
	t.Setenv("TARGET", "unknown")
	if _, err := selectedTarget(); err == nil {
		t.Fatal("selectedTarget accepted unknown TARGET")
	}
	t.Setenv("TARGET", "")
	target, err = selectedTarget()
	if err != nil {
		t.Fatal(err)
	}
	if target.Platform != runtime.GOOS || target.Architecture != runtime.GOARCH {
		t.Fatalf("host target = %#v", target)
	}
}

func TestVSCodeNodeToolingIsIntegrationLocal(t *testing.T) {
	root := t.TempDir()
	packageRoot := vscodePackageRoot(root)
	wantRoot := filepath.Join(root, "extensions", "vscode")
	if packageRoot != wantRoot {
		t.Fatalf("vscodePackageRoot() = %q, want %q", packageRoot, wantRoot)
	}

	t.Setenv("PATH", filepath.Join(root, "system-bin"))
	environment := nodeBinEnvironment(packageRoot)
	wantPath := filepath.Join(packageRoot, "node_modules", ".bin") + string(os.PathListSeparator) + filepath.Join(root, "system-bin")
	if len(environment) != 1 || environment[0] != "PATH="+wantPath {
		t.Fatalf("nodeBinEnvironment() = %v, want PATH=%s", environment, wantPath)
	}
	for _, entry := range filepath.SplitList(strings.TrimPrefix(environment[0], "PATH=")) {
		if entry == filepath.Join(root, "node_modules", ".bin") {
			t.Fatalf("nodeBinEnvironment() includes repository-root npm binaries: %v", environment)
		}
	}
}

func TestVSCodeDistributionPathsAreIntegrationLocal(t *testing.T) {
	root := t.TempDir()
	target, err := resolveTarget("linux-arm64")
	if err != nil {
		t.Fatal(err)
	}
	wantRoot := filepath.Join(root, "extensions", "vscode", "dist")
	if got := vscodeDistributionRoot(root); got != wantRoot {
		t.Fatalf("vscodeDistributionRoot() = %q, want %q", got, wantRoot)
	}
	wantPath := filepath.Join(wantRoot, "ferret-vscode-0.2.0-beta.1-linux-arm64.vsix")
	if got := vscodeVSIXPath(root, "0.2.0-beta.1", target); got != wantPath {
		t.Fatalf("vscodeVSIXPath() = %q, want %q", got, wantPath)
	}
}

func TestValidateVSIXChecksExactContentsMetadataBytesAndMode(t *testing.T) {
	root := t.TempDir()
	var target vscodeTarget
	for _, candidate := range vscodeTargets {
		if candidate.Unix && !isNativeTarget(candidate) {
			target = candidate
			break
		}
	}
	if target.ID == "" {
		t.Fatal("no non-native Unix VS Code target available")
	}
	// Structural cross-target validation must not execute these intentionally
	// synthetic daemon bytes. Native packaging jobs validate the staged real
	// ferretd executable and its version on each matching runner.
	binary := []byte("packaged daemon bytes")
	staged := filepath.Join(root, "ferretd")
	writeTestFile(t, staged, binary, 0o755)
	path := filepath.Join(root, vsixFilename("0.1.0", target))
	writeVSIX(t, path, target, binary, nil)
	manifest := vscodeManifest{Name: "fql", Version: "0.1.0", Publisher: vscodeMarketplacePublisher}
	if _, err := validateVSIX(context.Background(), path, target, staged, "2.0.0-alpha.2", manifest); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		change func(map[string]testZipEntry)
		want   string
	}{
		{"unexpected content", func(entries map[string]testZipEntry) {
			entries["extension/extra"] = testZipEntry{[]byte("extra"), 0o100644}
		}, "unexpected VSIX contents"},
		{"wrong target", func(entries map[string]testZipEntry) {
			entries["extension.vsixmanifest"] = testZipEntry{[]byte(`<Identity TargetPlatform="wrong-target"/>`), 0o100644}
		}, "target platform"},
		{"wrong manifest", func(entries map[string]testZipEntry) {
			entries["extension/package.json"] = testZipEntry{[]byte(`{"name":"fql","version":"9.9.9","publisher":"ferretlang"}`), 0o100644}
		}, "manifest identity"},
		{"wrong publisher", func(entries map[string]testZipEntry) {
			entries["extension/package.json"] = testZipEntry{[]byte(`{"name":"fql","version":"0.1.0","publisher":"not-ferretlang"}`), 0o100644}
		}, "manifest identity"},
		{"missing icon", func(entries map[string]testZipEntry) {
			delete(entries, "extension/media/icon.png")
		}, "unexpected VSIX contents"},
		{"wrong bytes", func(entries map[string]testZipEntry) {
			entries["extension/bin/ferretd"] = testZipEntry{[]byte("different"), 0o100755}
		}, "daemon bytes differ"},
		{"wrong mode", func(entries map[string]testZipEntry) {
			entries["extension/bin/ferretd"] = testZipEntry{binary, 0o100644}
		}, "mode is not 0755"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			badPath := filepath.Join(t.TempDir(), "bad.vsix")
			writeVSIX(t, badPath, target, binary, test.change)
			_, err := validateVSIX(context.Background(), badPath, target, staged, "2.0.0-alpha.2", manifest)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestCleanVSCodeOwnsOnlyIntegrationOutputs(t *testing.T) {
	root := t.TempDir()
	packageRoot := vscodePackageRoot(root)
	for _, path := range []string{"out/output.js", "bin/ferretd", ".vscode-test/cache", "dist/ferret.vsix", "node_modules/keep", "src/daemon/gen/keep.pb.ts"} {
		writeTestFile(t, filepath.Join(packageRoot, path), []byte("data"), 0o644)
	}
	if err := cleanVSCode(root); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{"out", "bin", ".vscode-test", "dist"} {
		if _, err := os.Stat(filepath.Join(packageRoot, removed)); !os.IsNotExist(err) {
			t.Fatalf("%s remains: %v", removed, err)
		}
	}
	for _, preserved := range []string{"node_modules/keep", "src/daemon/gen/keep.pb.ts"} {
		if _, err := os.Stat(filepath.Join(packageRoot, preserved)); err != nil {
			t.Fatalf("%s was removed: %v", preserved, err)
		}
	}
}

func TestRunExtensionsCleanScopesSharedOwnership(t *testing.T) {
	createRoot := func(t *testing.T) string {
		t.Helper()
		root := t.TempDir()
		for _, path := range []string{
			".dist/cache/artifact",
			"shared/proto/ferretd/daemon/v1/daemon.proto",
			"extensions/vscode/out/extension.js",
			"extensions/vscode/dist/ferret.vsix",
			"extensions/vscode/node_modules/keep",
			"extensions/vscode/src/daemon/gen/keep.pb.ts",
		} {
			writeTestFile(t, filepath.Join(root, path), []byte("data"), 0o644)
		}
		return root
	}
	t.Run("targeted", func(t *testing.T) {
		root := createRoot(t)
		if err := runExtensions(context.Background(), root, "clean", []string{"vscode"}); err != nil {
			t.Fatal(err)
		}
		for _, removed := range []string{"extensions/vscode/out", "extensions/vscode/dist"} {
			if _, err := os.Stat(filepath.Join(root, removed)); !os.IsNotExist(err) {
				t.Fatalf("targeted clean left %s: %v", removed, err)
			}
		}
		for _, preserved := range []string{".dist/cache/artifact", "shared/proto/ferretd/daemon/v1/daemon.proto", "extensions/vscode/node_modules/keep", "extensions/vscode/src/daemon/gen/keep.pb.ts"} {
			if _, err := os.Stat(filepath.Join(root, preserved)); err != nil {
				t.Fatalf("targeted clean removed %s: %v", preserved, err)
			}
		}
	})
	t.Run("unscoped", func(t *testing.T) {
		root := createRoot(t)
		if err := runExtensions(context.Background(), root, "clean", nil); err != nil {
			t.Fatal(err)
		}
		for _, removed := range []string{".dist", "shared/proto/ferretd", "extensions/vscode/out", "extensions/vscode/dist"} {
			if _, err := os.Stat(filepath.Join(root, removed)); !os.IsNotExist(err) {
				t.Fatalf("unscoped clean left %s: %v", removed, err)
			}
		}
		for _, preserved := range []string{"extensions/vscode/node_modules/keep", "extensions/vscode/src/daemon/gen/keep.pb.ts"} {
			if _, err := os.Stat(filepath.Join(root, preserved)); err != nil {
				t.Fatalf("unscoped clean removed %s: %v", preserved, err)
			}
		}
	})
}

type testZipEntry struct {
	contents []byte
	mode     os.FileMode
}

func writeVSIX(t *testing.T, path string, target vscodeTarget, binary []byte, change func(map[string]testZipEntry)) {
	t.Helper()
	entries := map[string]testZipEntry{
		"[Content_Types].xml":                       {[]byte("<Types/>"), 0o100644},
		"extension.vsixmanifest":                    {[]byte(`<Identity TargetPlatform="` + target.ID + `"/>`), 0o100644},
		"extension/LICENSE.txt":                     {[]byte("license"), 0o100644},
		"extension/language-configuration.json":     {[]byte("{}"), 0o100644},
		"extension/media/icon.png":                  {[]byte("png"), 0o100644},
		"extension/out/extension.js":                {[]byte("module.exports = {}"), 0o100644},
		"extension/package.json":                    {[]byte(`{"name":"fql","version":"0.1.0","publisher":"ferretlang"}`), 0o100644},
		"extension/readme.md":                       {[]byte("# Ferret"), 0o100644},
		"extension/syntaxes/ferret.tmLanguage.json": {[]byte("{}"), 0o100644},
		"extension/bin/" + target.BinaryName:        {binary, 0o100755},
	}
	if change != nil {
		change(entries)
	}
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for name, entry := range entries {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(entry.mode)
		output, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := output.Write(entry.contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, archive.Bytes(), 0o644)
}
