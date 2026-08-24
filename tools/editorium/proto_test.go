package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProtoSyncCachesRefreshesAndRemovesStaleFiles(t *testing.T) {
	root := protoTestRoot(t, "2.0.0-alpha.2")
	firstArchive := protoSourceArchive(t, "ferretd-2.0.0-alpha.2", append(requiredProtoEntries("old"), protoTestEntry{"removed/v1/removed.proto", []byte("stale"), tar.TypeReg}))
	requests := 0
	client := doerFunc(func(*http.Request) (*http.Response, error) {
		requests++
		return testResponse(http.StatusOK, firstArchive), nil
	})
	result, err := syncFerretdProto(context.Background(), root, false, client)
	if err != nil || !result.Updated || result.Version != "2.0.0-alpha.2" {
		t.Fatalf("syncFerretdProto() = %#v, %v", result, err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
	assertTestContents(t, filepath.Join(root, "shared", "proto", "ferretd", "daemon", "v1", "daemon.proto"), "daemon old")
	assertTestContents(t, filepath.Join(root, "shared", "proto", "ferretd", protoVersionMarker), "2.0.0-alpha.2\n")
	assertTestContents(t, filepath.Join(root, "shared", "proto", "google", "rpc", "status.proto"), "shared status")

	cached, err := syncFerretdProto(context.Background(), root, false, doerFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("matching schema tree performed a request")
		return nil, nil
	}))
	if err != nil || cached.Updated {
		t.Fatalf("cached sync = %#v, %v", cached, err)
	}

	secondArchive := protoSourceArchive(t, "ferretd-2.0.0-alpha.2", requiredProtoEntries("new"))
	result, err = syncFerretdProto(context.Background(), root, true, doerFunc(func(*http.Request) (*http.Response, error) {
		return testResponse(http.StatusOK, secondArchive), nil
	}))
	if err != nil || !result.Updated {
		t.Fatalf("forced sync = %#v, %v", result, err)
	}
	assertTestContents(t, filepath.Join(root, "shared", "proto", "ferretd", "daemon", "v1", "daemon.proto"), "daemon new")
	if _, err := os.Stat(filepath.Join(root, "shared", "proto", "ferretd", "removed", "v1", "removed.proto")); !os.IsNotExist(err) {
		t.Fatalf("stale schema remains: %v", err)
	}
}

func TestProtoSyncRejectsUnsafeDuplicateMissingAndOversizedArchivesWithoutDamage(t *testing.T) {
	root := protoTestRoot(t, "2.0.0-alpha.2")
	goodArchive := protoSourceArchive(t, "ferretd-2.0.0-alpha.2", requiredProtoEntries("good"))
	if _, err := syncFerretdProto(context.Background(), root, false, staticArchiveClient(goodArchive)); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		archive []byte
		want    string
	}{
		{
			name: "unsafe traversal",
			archive: protoSourceArchive(t, "ferretd-2.0.0-alpha.2", append(
				requiredProtoEntries("bad"), protoTestEntry{"safe/../../escape.proto", []byte("unsafe"), tar.TypeReg},
			)),
			want: "unsafe schema archive path",
		},
		{
			name:    "unsafe source root",
			archive: protoSourceArchive(t, "..", requiredProtoEntries("bad")),
			want:    "unsafe schema archive path",
		},
		{
			name:    "missing required",
			archive: protoSourceArchive(t, "ferretd-2.0.0-alpha.2", []protoTestEntry{{"daemon/v1/daemon.proto", []byte("daemon"), tar.TypeReg}}),
			want:    "missing required ferretd schema",
		},
		{
			name: "oversized",
			archive: protoSourceArchive(t, "ferretd-2.0.0-alpha.2", append(
				requiredProtoEntries("bad")[1:], protoTestEntry{"daemon/v1/daemon.proto", bytes.Repeat([]byte{'x'}, maximumProtoFileSize+1), tar.TypeReg},
			)),
			want: "exceeds the file size limit",
		},
	}
	duplicateEntries := append(requiredProtoEntries("bad"), requiredProtoEntries("bad")[0])
	tests = append(tests, struct {
		name    string
		archive []byte
		want    string
	}{"duplicate", protoSourceArchive(t, "ferretd-2.0.0-alpha.2", duplicateEntries), "duplicate daemon/v1/daemon.proto"})

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := syncFerretdProto(context.Background(), root, true, staticArchiveClient(test.archive))
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			assertTestContents(t, filepath.Join(root, "shared", "proto", "ferretd", "daemon", "v1", "daemon.proto"), "daemon good")
			if _, err := os.Stat(filepath.Join(root, "shared", "proto", "escape.proto")); !os.IsNotExist(err) {
				t.Fatalf("unsafe file exists: %v", err)
			}
			assertNoProtoTemporaryTrees(t, root)
		})
	}
}

func TestReplaceDirectoryAtomicRestoresPreviousTree(t *testing.T) {
	parent := t.TempDir()
	destination := filepath.Join(parent, "ferretd")
	writeTestFile(t, filepath.Join(destination, "old.proto"), []byte("old"), 0o644)
	err := replaceDirectoryAtomic(filepath.Join(parent, "missing-source"), destination)
	if err == nil {
		t.Fatal("replaceDirectoryAtomic succeeded with a missing source")
	}
	assertTestContents(t, filepath.Join(destination, "old.proto"), "old")
	assertNoProtoTemporaryTreesAt(t, parent)
}

func TestCompareTreesReportsMissingUnexpectedAndOutdatedFiles(t *testing.T) {
	expected := t.TempDir()
	actual := t.TempDir()
	writeTestFile(t, filepath.Join(expected, "same.pb.ts"), []byte("same"), 0o644)
	writeTestFile(t, filepath.Join(actual, "same.pb.ts"), []byte("same"), 0o644)
	if err := compareTrees(expected, actual); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(expected, "old.pb.ts"), []byte("old"), 0o644)
	writeTestFile(t, filepath.Join(actual, "old.pb.ts"), []byte("new"), 0o644)
	writeTestFile(t, filepath.Join(expected, "missing.pb.ts"), []byte("missing"), 0o644)
	writeTestFile(t, filepath.Join(actual, "unexpected.pb.ts"), []byte("unexpected"), 0o644)
	err := compareTrees(expected, actual)
	for _, text := range []string{"outdated generated file: old.pb.ts", "missing generated file: missing.pb.ts", "unexpected generated file: unexpected.pb.ts"} {
		if err == nil || !strings.Contains(err.Error(), text) {
			t.Fatalf("compareTrees error = %v, missing %q", err, text)
		}
	}
}

type protoTestEntry struct {
	path     string
	contents []byte
	typeflag byte
}

func requiredProtoEntries(suffix string) []protoTestEntry {
	return []protoTestEntry{
		{"daemon/v1/daemon.proto", []byte("daemon " + suffix), tar.TypeReg},
		{"execution/v1/execution.proto", []byte("execution " + suffix), tar.TypeReg},
		{"workspace/v1/workspace.proto", []byte("workspace " + suffix), tar.TypeReg},
	}
}

func protoSourceArchive(t *testing.T, sourceRoot string, entries []protoTestEntry) []byte {
	t.Helper()
	var result bytes.Buffer
	gzipWriter := gzip.NewWriter(&result)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		name := sourceRoot + "/proto/ferretd/" + entry.path
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(entry.contents)), Typeflag: entry.typeflag}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(entry.contents); err != nil {
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

func protoTestRoot(t *testing.T, version string) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "ferretd.json"), []byte("{\"ferretd\":\""+version+"\"}\n"), 0o644)
	writeTestFile(t, filepath.Join(root, "shared", "proto", "google", "rpc", "status.proto"), []byte("shared status"), 0o644)
	return root
}

func staticArchiveClient(archive []byte) httpDoer {
	return doerFunc(func(*http.Request) (*http.Response, error) {
		return testResponse(http.StatusOK, archive), nil
	})
}

func assertTestContents(t *testing.T, path, expected string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil || string(contents) != expected {
		t.Fatalf("%s = %q, %v; want %q", path, contents, err, expected)
	}
}

func assertNoProtoTemporaryTrees(t *testing.T, root string) {
	t.Helper()
	assertNoProtoTemporaryTreesAt(t, filepath.Join(root, "shared", "proto"))
}

func assertNoProtoTemporaryTreesAt(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".ferretd-stage-") || strings.Contains(entry.Name(), ".ferretd.backup-") {
			t.Fatalf("temporary proto tree remains: %s", entry.Name())
		}
	}
}
