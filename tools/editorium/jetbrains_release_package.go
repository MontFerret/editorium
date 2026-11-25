package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A changed pluginVersion changes the ZIP name; Gradle can retain the previous
// generated ZIP. Preserve the package verifier's exact-one-archive invariant.
func prepareJetBrainsReleasePackage(root string) error {
	directory := filepath.Join(jetbrainsPackageRoot(root), "build", "distributions")
	for _, path := range []string{filepath.Dir(directory), directory} {
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("JetBrains distribution output must be an owned directory: %s", path)
		}
	}
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var archives []string
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".zip") {
			continue
		}
		version, ok := strings.CutPrefix(entry.Name(), jetbrainsArchiveRoot+"-")
		version = strings.TrimSuffix(version, ".zip")
		if !ok || !fullReleaseVersion(version) || !entry.Type().IsRegular() {
			return fmt.Errorf("unexpected JetBrains distribution archive %s; inspect generated outputs before releasing", entry.Name())
		}
		archives = append(archives, filepath.Join(directory, entry.Name()))
	}
	for _, path := range archives {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return nil
}
