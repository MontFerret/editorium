package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type doerFunc func(*http.Request) (*http.Response, error)

func (function doerFunc) Do(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestFerretdTargetMappings(t *testing.T) {
	expected := []ferretdTarget{
		{ID: "darwin-arm64", Platform: "darwin", Architecture: "arm64", GoOS: "darwin", GoArch: "arm64", Artifact: "ferretd_darwin_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
		{ID: "darwin-x64", Platform: "darwin", Architecture: "x64", GoOS: "darwin", GoArch: "amd64", Artifact: "ferretd_darwin_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
		{ID: "linux-arm64", Platform: "linux", Architecture: "arm64", GoOS: "linux", GoArch: "arm64", Artifact: "ferretd_linux_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
		{ID: "linux-x64", Platform: "linux", Architecture: "x64", GoOS: "linux", GoArch: "amd64", Artifact: "ferretd_linux_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Unix: true},
		{ID: "win32-arm64", Platform: "win32", Architecture: "arm64", GoOS: "windows", GoArch: "arm64", Artifact: "ferretd_windows_arm64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Unix: false},
		{ID: "win32-x64", Platform: "win32", Architecture: "x64", GoOS: "windows", GoArch: "amd64", Artifact: "ferretd_windows_x86_64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Unix: false},
	}
	if len(ferretdTargets) != len(expected) {
		t.Fatalf("ferretd target count = %d, want %d", len(ferretdTargets), len(expected))
	}
	for index, want := range expected {
		got := ferretdTargets[index]
		if got != want {
			t.Fatalf("ferretd target %d = %#v, want %#v", index, got, want)
		}
		resolved, err := resolveFerretdTarget(want.ID)
		if err != nil || resolved != want {
			t.Fatalf("resolveFerretdTarget(%s) = %#v, %v", want.ID, resolved, err)
		}
		detected, err := detectHostFerretdTarget(want.GoOS, want.GoArch)
		if err != nil || detected != want {
			t.Fatalf("detectHostFerretdTarget(%s, %s) = %#v, %v", want.GoOS, want.GoArch, detected, err)
		}
	}
	if _, err := resolveFerretdTarget("linux-armhf"); err == nil || !strings.Contains(err.Error(), strings.Join(ferretdTargetIDs(), ", ")) {
		t.Fatalf("resolveFerretdTarget unknown error = %v", err)
	}
	if _, err := detectHostFerretdTarget("freebsd", "amd64"); err == nil {
		t.Fatal("detectHostFerretdTarget accepted unsupported host")
	}
}

func TestReadFerretdVersionRequiresExactManifest(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte(`{"ferretd":"2.0.0-alpha.2"}`), 0o644)
	version, err := readFerretdVersion(root)
	if err != nil || version != "2.0.0-alpha.2" {
		t.Fatalf("readFerretdVersion() = %q, %v", version, err)
	}
	for _, contents := range []string{
		`{"ferretd":"latest"}`,
		`{"ferretd":"2.0.0","extra":true}`,
		`{"ferretd":"2.0.0","ferretd":"2.0.1"}`,
		`{"ferretd":2}`,
	} {
		writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte(contents), 0o644)
		if _, err := readFerretdVersion(root); err == nil || !strings.Contains(err.Error(), "exactly one valid") {
			t.Fatalf("readFerretdVersion(%s) error = %v", contents, err)
		}
	}
}

func TestChecksumsAndOfficialURLs(t *testing.T) {
	first := strings.Repeat("1", 64)
	second := strings.Repeat("a", 64)
	checksums, err := parseChecksums(first + "  ferretd_linux_x86_64.tar.gz\r\n" + second + "  ferretd_windows_arm64.zip\r\n")
	if err != nil || checksums["ferretd_linux_x86_64.tar.gz"] != first || checksums["ferretd_windows_arm64.zip"] != second {
		t.Fatalf("parseChecksums() = %#v, %v", checksums, err)
	}
	for _, contents := range []string{first + " *unsafe/path\n", first + "  duplicate\n" + first + "  duplicate\n", ""} {
		if _, err := parseChecksums(contents); err == nil {
			t.Fatalf("parseChecksums(%q) succeeded", contents)
		}
	}
	assetURL, err := releaseAssetURL("2.0.0-alpha.2", checksumAsset)
	if err != nil || assetURL != "https://github.com/MontFerret/ferretd/releases/download/v2.0.0-alpha.2/ferretd_checksums.txt" {
		t.Fatalf("releaseAssetURL() = %q, %v", assetURL, err)
	}
	sourceURL, err := sourceArchiveURL("2.0.0-alpha.2")
	if err != nil || sourceURL != "https://github.com/MontFerret/ferretd/archive/refs/tags/v2.0.0-alpha.2.tar.gz" {
		t.Fatalf("sourceArchiveURL() = %q, %v", sourceURL, err)
	}
	if _, err := releaseAssetURL("latest", checksumAsset); err == nil {
		t.Fatal("releaseAssetURL accepted latest")
	}
	if _, err := releaseAssetURL("2.0.0", "../ferretd"); err == nil {
		t.Fatal("releaseAssetURL accepted an unsafe asset")
	}
}

func TestAcquireFerretdVerifiesExtractsCachesAndEvictsCorruption(t *testing.T) {
	tests := []struct {
		name     string
		target   string
		data     []byte
		expected []byte
	}{
		{name: "tar", target: "linux-x64", expected: []byte("verified daemon")},
		{name: "zip", target: "win32-x64", expected: []byte("verified windows daemon")},
	}
	tests[0].data = testTarGzip(t, map[string][]byte{"README.md": []byte("ignored"), "ferretd": tests[0].expected})
	tests[1].data = testZip(t, map[string][]byte{"LICENSE": []byte("ignored"), "ferretd.exe": tests[1].expected})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := pinnedTestRoot(t)
			target, err := resolveFerretdTarget(test.target)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(test.data)
			requests := 0
			client := doerFunc(func(request *http.Request) (*http.Response, error) {
				requests++
				var body []byte
				switch {
				case strings.HasSuffix(request.URL.Path, "/"+checksumAsset):
					body = []byte(hex.EncodeToString(digest[:]) + "  " + target.Artifact + "\n")
				case strings.HasSuffix(request.URL.Path, "/"+target.Artifact):
					body = test.data
				default:
					return testResponse(http.StatusNotFound, []byte("not found")), nil
				}
				return testResponse(http.StatusOK, body), nil
			})
			acquired, err := acquireFerretd(context.Background(), root, target, client)
			if err != nil {
				t.Fatal(err)
			}
			contents, err := os.ReadFile(acquired.BinaryPath)
			if err != nil || !bytes.Equal(test.expected, contents) {
				t.Fatalf("extracted contents %q, %v", contents, err)
			}
			if target.Unix {
				info, err := os.Stat(acquired.BinaryPath)
				if err != nil || info.Mode().Perm() != 0o755 {
					t.Fatalf("Unix executable mode = %v, %v", info.Mode().Perm(), err)
				}
			}
			if requests != 2 {
				t.Fatalf("requests = %d, want 2", requests)
			}
			if _, err := acquireFerretd(context.Background(), root, target, doerFunc(func(*http.Request) (*http.Response, error) {
				t.Fatal("cache hit performed a request")
				return nil, nil
			})); err != nil {
				t.Fatal(err)
			}

			writeTestFile(t, acquired.ArchivePath, []byte("corrupt"), 0o644)
			if _, err := acquireFerretd(context.Background(), root, target, doerFunc(func(*http.Request) (*http.Response, error) {
				t.Fatal("checksum mismatch should fail closed before retrying")
				return nil, nil
			})); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
				t.Fatalf("checksum mismatch error = %v", err)
			}
			if _, err := os.Stat(acquired.ArchivePath); !os.IsNotExist(err) {
				t.Fatalf("corrupt cache was not evicted: %v", err)
			}
		})
	}
}

func TestArchiveExtractionRequiresExactUniqueRootBinary(t *testing.T) {
	target, _ := resolveFerretdTarget("linux-x64")
	for _, entries := range []map[string][]byte{
		{"nested/ferretd": []byte("wrong")},
		{"ferretd/child": []byte("wrong")},
	} {
		path := filepath.Join(t.TempDir(), target.Artifact)
		writeTestFile(t, path, testTarGzip(t, entries), 0o644)
		if _, err := extractBinary(path, target); err == nil {
			t.Fatalf("extractBinary accepted %#v", entries)
		}
	}
}

func pinnedTestRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte("{\"ferretd\":\"2.0.0-alpha.2\"}\n"), 0o644)
	return root
}

func testResponse(status int, contents []byte) *http.Response {
	return &http.Response{StatusCode: status, Status: http.StatusText(status), Body: io.NopCloser(bytes.NewReader(contents))}
}

func testTarGzip(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var result bytes.Buffer
	gzipWriter := gzip.NewWriter(&result)
	tarWriter := tar.NewWriter(gzipWriter)
	for name, contents := range entries {
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(contents)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func testZip(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	for name, contents := range entries {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0o100755)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func writeTestFile(t *testing.T, path string, contents []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, mode); err != nil {
		t.Fatal(err)
	}
}
