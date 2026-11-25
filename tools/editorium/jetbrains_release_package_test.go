package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestJetBrainsReleasePackagePreparation(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(jetbrainsPackageRoot(root), "build/distributions")
	if err := prepareJetBrainsReleasePackage(root); err != nil {
		t.Fatal(err)
	}
	previous := filepath.Join(directory, "ferret-jetbrains-0.1.0.zip")
	writeTestFile(t, previous, []byte("previous generated package"), 0o644)
	unexpected := filepath.Join(directory, "unexpected.zip")
	writeTestFile(t, unexpected, []byte("unrelated archive"), 0o644)
	if err := prepareJetBrainsReleasePackage(root); err == nil {
		t.Fatal("accepted unexpected distribution")
	}
	if _, err := os.Stat(previous); err != nil {
		t.Fatal("removed archive before validating complete directory")
	}
	if err := os.Remove(unexpected); err != nil {
		t.Fatal(err)
	}
	if err := prepareJetBrainsReleasePackage(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Fatal("retained stale generated ZIP")
	}
}

func TestJetBrainsReleasePackagePreservesLinkedOutputs(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	archive := filepath.Join(outside, "ferret-jetbrains-0.1.0.zip")
	writeTestFile(t, archive, []byte("external"), 0o644)
	build := filepath.Join(jetbrainsPackageRoot(root), "build")
	if err := os.MkdirAll(build, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(build, "distributions")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := prepareJetBrainsReleasePackage(root); err == nil {
		t.Fatal("accepted symlinked output")
	}
	if _, err := os.Stat(archive); err != nil {
		t.Fatal("removed external archive")
	}
}
