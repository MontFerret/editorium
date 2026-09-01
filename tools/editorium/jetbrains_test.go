package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func TestJetBrainsOperationsUseIntegrationLocalGradleWrapper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell wrapper fixture is exercised on Unix")
	}
	root := t.TempDir()
	packageRoot := jetbrainsPackageRoot(root)
	logPath := filepath.Join(root, "gradle-calls.log")
	wrapper := filepath.Join(packageRoot, "gradlew")
	writeTestFile(t, wrapper, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$JETBRAINS_TEST_LOG\"\n"), 0o755)
	t.Setenv("JETBRAINS_TEST_LOG", logPath)

	for _, operation := range []string{"build", "test", "lint"} {
		if err := runJetBrainsOperation(context.Background(), root, operation); err != nil {
			t.Fatal(err)
		}
	}
	if err := runJetBrainsGradle(context.Background(), root, "buildPlugin", "verifyPluginProjectConfiguration", "verifyPluginStructure", "verifyPlugin"); err != nil {
		t.Fatal(err)
	}

	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"buildPlugin verifyPluginProjectConfiguration verifyPluginStructure",
		"test",
		"compileKotlin compileTestKotlin verifyPluginProjectConfiguration verifyPluginStructure verifyPlugin",
		"buildPlugin verifyPluginProjectConfiguration verifyPluginStructure verifyPlugin",
	} {
		if !strings.Contains(string(contents), expected) {
			t.Fatalf("Gradle calls do not contain %q:\n%s", expected, contents)
		}
	}
}

func TestCleanJetBrainsOwnsOnlyBuildOutput(t *testing.T) {
	root := t.TempDir()
	packageRoot := jetbrainsPackageRoot(root)
	for _, path := range []string{"build/distributions/plugin.zip", ".gradle/cache.bin", ".intellijPlatform/cache.bin", "src/main/kotlin/Keep.kt"} {
		writeTestFile(t, filepath.Join(packageRoot, path), []byte("data"), 0o644)
	}

	if err := cleanJetBrains(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(packageRoot, "build")); !os.IsNotExist(err) {
		t.Fatalf("JetBrains build output remains: %v", err)
	}
	for _, preserved := range []string{".gradle/cache.bin", ".intellijPlatform/cache.bin", "src/main/kotlin/Keep.kt"} {
		if _, err := os.Stat(filepath.Join(packageRoot, preserved)); err != nil {
			t.Fatalf("clean removed %s: %v", preserved, err)
		}
	}
}

func TestPrepareJetBrainsFerretdStagesEveryTargetCachesAndPreservesPriorOutput(t *testing.T) {
	root := pinnedTestRoot(t)
	archives, checksums := jetbrainsReleaseFixtures(t)
	requests := 0
	client := doerFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		asset := filepath.Base(request.URL.Path)
		if asset == checksumAsset {
			return testResponse(http.StatusOK, checksums), nil
		}
		contents, ok := archives[asset]
		if !ok {
			return testResponse(http.StatusNotFound, []byte("not found")), nil
		}
		return testResponse(http.StatusOK, contents), nil
	})
	prepared, err := prepareJetBrainsFerretd(context.Background(), root, client)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Version != "2.0.0-alpha.2" || len(prepared.Acquired) != len(ferretdTargets) {
		t.Fatalf("prepared = %#v", prepared)
	}
	if requests != len(ferretdTargets)*2 {
		t.Fatalf("release requests = %d, want %d", requests, len(ferretdTargets)*2)
	}
	assertTestContents(t, filepath.Join(prepared.Root, jetbrainsFerretdVersionFile), "2.0.0-alpha.2\n")
	for _, target := range ferretdTargets {
		path := filepath.Join(prepared.Root, target.Platform, target.Architecture, target.BinaryName)
		assertTestContents(t, path, "binary "+target.ID)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		wantMode := os.FileMode(0o644)
		if target.Unix {
			wantMode = 0o755
		}
		if info.Mode().Perm() != wantMode {
			t.Fatalf("%s mode = %04o, want %04o", target.ID, info.Mode().Perm(), wantMode)
		}
	}

	if _, err := prepareJetBrainsFerretd(context.Background(), root, doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("verified cache performed a request")
		return nil, nil
	})); err != nil {
		t.Fatal(err)
	}

	writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte("{\"ferretd\":\"2.0.0-alpha.3\"}\n"), 0o644)
	_, err = prepareJetBrainsFerretd(context.Background(), root, doerFunc(func(*http.Request) (*http.Response, error) {
		return testResponse(http.StatusBadGateway, []byte("unavailable")), nil
	}))
	if err == nil || !strings.Contains(err.Error(), "HTTP Bad Gateway") {
		t.Fatalf("failed preparation error = %v", err)
	}
	assertTestContents(t, filepath.Join(prepared.Root, jetbrainsFerretdVersionFile), "2.0.0-alpha.2\n")
}

func TestValidateJetBrainsArchiveChecksMatrixVersionBytesAndModes(t *testing.T) {
	root := t.TempDir()
	stagedRoot := filepath.Join(root, "generated", "ferretd")
	version := "2.0.0-alpha.2"
	writeTestFile(t, filepath.Join(stagedRoot, jetbrainsFerretdVersionFile), []byte(version+"\n"), 0o644)
	for _, target := range ferretdTargets {
		mode := os.FileMode(0o644)
		if target.Unix {
			mode = 0o755
		}
		writeTestFile(t, filepath.Join(stagedRoot, target.Platform, target.Architecture, target.BinaryName), []byte("binary "+target.ID), mode)
	}
	path := filepath.Join(root, "ferret-jetbrains-0.1.0.zip")
	writeJetBrainsTestArchive(t, path, stagedRoot, version, nil)
	smoked := ""
	if err := validateJetBrainsArchiveWithSmoke(context.Background(), path, stagedRoot, version, func(_ context.Context, _ []byte, target ferretdTarget, _ string) error {
		smoked = target.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if native, err := detectHostFerretdTarget(runtime.GOOS, runtime.GOARCH); err == nil && smoked != native.ID {
		t.Fatalf("smoked target = %q, want %q", smoked, native.ID)
	}

	unixTarget, _ := resolveFerretdTarget("linux-x64")
	unixEntry := jetbrainsArchiveRoot + "/ferretd/linux/x64/ferretd"
	tests := []struct {
		name   string
		change func(map[string]testZipEntry)
		want   string
	}{
		{"missing target", func(entries map[string]testZipEntry) { delete(entries, unixEntry) }, "unexpected JetBrains ferretd contents"},
		{"unexpected target", func(entries map[string]testZipEntry) {
			entries[jetbrainsArchiveRoot+"/ferretd/extra"] = testZipEntry{[]byte("extra"), 0o100644}
		}, "unexpected JetBrains ferretd contents"},
		{"wrong version", func(entries map[string]testZipEntry) {
			entries[jetbrainsArchiveRoot+"/ferretd/version"] = testZipEntry{[]byte("9.9.9\n"), 0o100644}
		}, "packaged JetBrains ferretd version"},
		{"wrong bytes", func(entries map[string]testZipEntry) { entries[unixEntry] = testZipEntry{[]byte("wrong"), 0o100755} }, "bytes differ"},
		{"wrong mode", func(entries map[string]testZipEntry) {
			entries[unixEntry] = testZipEntry{[]byte("binary " + unixTarget.ID), 0o100644}
		}, "expected 0755"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			writeJetBrainsTestArchive(t, path, stagedRoot, version, test.change)
			err := validateJetBrainsArchiveWithSmoke(context.Background(), path, stagedRoot, version, func(context.Context, []byte, ferretdTarget, string) error { return nil })
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validation error = %v, want %q", err, test.want)
			}
		})
	}
}

func jetbrainsReleaseFixtures(t *testing.T) (map[string][]byte, []byte) {
	t.Helper()
	archives := make(map[string][]byte, len(ferretdTargets))
	var checksumLines []string
	for _, target := range ferretdTargets {
		binary := []byte("binary " + target.ID)
		var archive []byte
		if target.ArchiveType == "zip" {
			archive = testZip(t, map[string][]byte{target.BinaryName: binary})
		} else {
			archive = testTarGzip(t, map[string][]byte{target.BinaryName: binary})
		}
		archives[target.Artifact] = archive
		digest := sha256.Sum256(archive)
		checksumLines = append(checksumLines, hex.EncodeToString(digest[:])+"  "+target.Artifact)
	}
	sort.Strings(checksumLines)
	return archives, []byte(strings.Join(checksumLines, "\n") + "\n")
}

func writeJetBrainsTestArchive(t *testing.T, path, stagedRoot, version string, change func(map[string]testZipEntry)) {
	t.Helper()
	entries := map[string]testZipEntry{
		jetbrainsArchiveRoot + "/lib/ferret-jetbrains.jar": {[]byte("plugin"), 0o100644},
		jetbrainsArchiveRoot + "/ferretd/version":          {[]byte(version + "\n"), 0o100644},
	}
	for _, target := range ferretdTargets {
		contents, err := os.ReadFile(filepath.Join(stagedRoot, target.Platform, target.Architecture, target.BinaryName))
		if err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o100644)
		if target.Unix {
			mode = 0o100755
		}
		name := jetbrainsArchiveRoot + "/ferretd/" + filepath.ToSlash(filepath.Join(target.Platform, target.Architecture, target.BinaryName))
		entries[name] = testZipEntry{contents, mode}
	}
	if change != nil {
		change(entries)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, entry := range entries {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(entry.mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(entry.contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, output.Bytes(), 0o644)
}
