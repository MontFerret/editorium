package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const (
	jetbrainsArchiveRoot        = "ferret-jetbrains"
	jetbrainsFerretdVersionFile = "version"
	maximumJetBrainsEntrySize   = 128 * 1024 * 1024
)

type preparedJetBrainsFerretd struct {
	Root     string
	Version  string
	Acquired map[string]acquiredFerretd
}

func runJetBrainsOperation(ctx context.Context, root, operation string) error {
	switch operation {
	case "prepare":
		_, err := prepareJetBrainsFerretd(ctx, root, nil)
		return err
	case "build":
		return runJetBrainsGradle(ctx, root, "buildPlugin", "verifyPluginProjectConfiguration", "verifyPluginStructure")
	case "test":
		if _, err := syncFerretdProto(ctx, root, false, nil); err != nil {
			return err
		}

		if err := generateJetBrainsProto(ctx, root, true); err != nil {
			return err
		}

		prepared, err := prepareJetBrainsTestFerretd(ctx, root, nil)
		if err != nil {
			return err
		}

		if err := runJetBrainsGradle(ctx, root, "test"); err != nil {
			return err
		}

		return runJetBrainsGradleEnvironment(
			ctx,
			root,
			[]string{"FERRETD_TEST_PATH=" + prepared.BinaryPath},
			"ferretdIntegrationTest",
		)
	case "lint":
		if _, err := syncFerretdProto(ctx, root, false, nil); err != nil {
			return err
		}

		if err := generateJetBrainsProto(ctx, root, true); err != nil {
			return err
		}

		return runJetBrainsGradle(ctx, root, "compileKotlin", "compileTestKotlin", "verifyPluginProjectConfiguration", "verifyPluginStructure", "verifyPlugin")
	case "clean":
		return cleanJetBrains(root)
	default:
		return fmt.Errorf("unknown JetBrains operation %q", operation)
	}
}

func prepareJetBrainsTestFerretd(ctx context.Context, root string, client httpDoer) (acquiredFerretd, error) {
	target, err := detectHostFerretdTarget(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return acquiredFerretd{}, err
	}

	result, err := acquireFerretd(ctx, root, target, client)
	if err != nil {
		return acquiredFerretd{}, fmt.Errorf("prepare JetBrains integration-test daemon %s: %w", target.ID, err)
	}

	return result, nil
}

func packageJetBrains(ctx context.Context, root string) error {
	if err := runJetBrainsGradle(ctx, root, "buildPlugin", "verifyPluginProjectConfiguration", "verifyPluginStructure", "verifyPlugin"); err != nil {
		return err
	}
	return checkJetBrainsPackage(ctx, root)
}

func prepareJetBrainsFerretd(ctx context.Context, root string, client httpDoer) (preparedJetBrainsFerretd, error) {
	version, err := readFerretdVersion(root)
	if err != nil {
		return preparedJetBrainsFerretd{}, err
	}

	generatedRoot := jetbrainsGeneratedRoot(root)
	if err := os.MkdirAll(filepath.Dir(generatedRoot), 0o755); err != nil {
		return preparedJetBrainsFerretd{}, err
	}

	stagingRoot, err := os.MkdirTemp(filepath.Dir(generatedRoot), ".ferretd-stage-")
	if err != nil {
		return preparedJetBrainsFerretd{}, err
	}

	defer os.RemoveAll(stagingRoot)

	acquired := make(map[string]acquiredFerretd, len(ferretdTargets))
	for _, target := range ferretdTargets {
		binary, acquireErr := acquireFerretd(ctx, root, target, client)

		if acquireErr != nil {
			return preparedJetBrainsFerretd{}, fmt.Errorf("prepare JetBrains ferretd target %s: %w", target.ID, acquireErr)
		}

		mode := os.FileMode(0o644)
		if target.Unix {
			mode = 0o755
		}

		destination := filepath.Join(stagingRoot, target.Platform, target.Architecture, target.BinaryName)
		if err := copyFileAtomic(binary.BinaryPath, destination, mode); err != nil {
			return preparedJetBrainsFerretd{}, fmt.Errorf("stage JetBrains ferretd target %s: %w", target.ID, err)
		}

		acquired[target.ID] = binary
	}

	if err := writeFileAtomic(filepath.Join(stagingRoot, jetbrainsFerretdVersionFile), []byte(version+"\n"), 0o644); err != nil {
		return preparedJetBrainsFerretd{}, err
	}

	if err := replaceDirectoryAtomic(stagingRoot, generatedRoot); err != nil {
		return preparedJetBrainsFerretd{}, err
	}

	fmt.Printf("Prepared ferretd %s for JetBrains (%d targets): %s\n", version, len(ferretdTargets), generatedRoot)

	return preparedJetBrainsFerretd{Root: generatedRoot, Version: version, Acquired: acquired}, nil
}

func checkJetBrainsPackage(ctx context.Context, root string) error {
	version, err := readFerretdVersion(root)
	if err != nil {
		return err
	}

	archivePath, err := jetbrainsArchivePath(root)
	if err != nil {
		return err
	}

	if err := validateJetBrainsArchive(ctx, archivePath, jetbrainsGeneratedRoot(root), version); err != nil {
		return err
	}

	fmt.Printf("Verified %s\n", archivePath)

	return nil
}

func validateJetBrainsArchive(ctx context.Context, path, stagedRoot, version string) error {
	return validateJetBrainsArchiveWithSmoke(ctx, path, stagedRoot, version, smokePackagedJetBrainsFerretd)
}

func validateJetBrainsArchiveWithSmoke(ctx context.Context, path, stagedRoot, version string, smoke func(context.Context, []byte, ferretdTarget, string) error) error {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()

	prefix := jetbrainsArchiveRoot + "/ferretd/"
	entries := make(map[string]*zip.File)

	for _, file := range archive.File {
		if _, duplicate := entries[file.Name]; duplicate {
			return fmt.Errorf("duplicate JetBrains plugin entry: %s", file.Name)
		}

		entries[file.Name] = file
	}

	expected := make(map[string]ferretdTarget, len(ferretdTargets))
	for _, target := range ferretdTargets {
		name := prefix + filepath.ToSlash(filepath.Join(target.Platform, target.Architecture, target.BinaryName))
		expected[name] = target
	}

	versionEntry := prefix + jetbrainsFerretdVersionFile

	var actual []string
	for name, file := range entries {
		if !strings.HasPrefix(name, prefix) || file.FileInfo().IsDir() {
			continue
		}

		actual = append(actual, name)
	}

	var wanted []string
	for name := range expected {
		wanted = append(wanted, name)
	}

	wanted = append(wanted, versionEntry)
	sort.Strings(actual)
	sort.Strings(wanted)

	if strings.Join(actual, "\n") != strings.Join(wanted, "\n") {
		return fmt.Errorf("unexpected JetBrains ferretd contents: got %v, want %v", actual, wanted)
	}

	marker, err := readJetBrainsZipEntry(entries[versionEntry])
	if err != nil {
		return err
	}

	if string(marker) != version+"\n" {
		return fmt.Errorf("packaged JetBrains ferretd version is %q; expected %q", strings.TrimSpace(string(marker)), version)
	}

	for name, target := range expected {
		file := entries[name]
		contents, err := readJetBrainsZipEntry(file)
		if err != nil {
			return err
		}

		stagedPath := filepath.Join(stagedRoot, target.Platform, target.Architecture, target.BinaryName)
		staged, err := os.ReadFile(stagedPath)
		if err != nil {
			return fmt.Errorf("read staged JetBrains ferretd target %s: %w", target.ID, err)
		}

		if !bytes.Equal(contents, staged) {
			return fmt.Errorf("packaged JetBrains ferretd bytes differ for %s", target.ID)
		}

		if target.Unix && file.Mode().Perm() != 0o755 {
			return fmt.Errorf("packaged JetBrains ferretd mode for %s is %04o; expected 0755", target.ID, file.Mode().Perm())
		}

		if target.GoOS == runtime.GOOS && target.GoArch == runtime.GOARCH {
			if err := smoke(ctx, contents, target, version); err != nil {
				return err
			}
		}
	}

	return nil
}

func readJetBrainsZipEntry(file *zip.File) ([]byte, error) {
	if file == nil {
		return nil, fmt.Errorf("missing JetBrains plugin entry")
	}

	if file.UncompressedSize64 > maximumJetBrainsEntrySize || !file.Mode().IsRegular() {
		return nil, fmt.Errorf("JetBrains plugin entry is not a bounded regular file: %s", file.Name)
	}

	reader, err := file.Open()
	if err != nil {
		return nil, err
	}

	defer reader.Close()

	var buffer bytes.Buffer
	if err := copyLimited(&buffer, reader, maximumJetBrainsEntrySize, "JetBrains plugin entry"); err != nil {
		return nil, err
	}

	return buffer.Bytes(), nil
}

func smokePackagedJetBrainsFerretd(ctx context.Context, contents []byte, target ferretdTarget, version string) error {
	temporary, err := os.MkdirTemp("", "ferret-jetbrains-")
	if err != nil {
		return err
	}

	defer os.RemoveAll(temporary)

	path := filepath.Join(temporary, target.BinaryName)
	mode := os.FileMode(0o644)
	if target.Unix {
		mode = 0o755
	}

	if err := os.WriteFile(path, contents, mode); err != nil {
		return err
	}

	return smokeFerretd(ctx, path, version)
}

func runJetBrainsGradle(ctx context.Context, root string, args ...string) error {
	return runJetBrainsGradleEnvironment(ctx, root, nil, args...)
}

func runJetBrainsGradleEnvironment(ctx context.Context, root string, environment []string, args ...string) error {
	packageRoot := jetbrainsPackageRoot(root)
	wrapper := "gradlew"

	if runtime.GOOS == "windows" {
		wrapper += ".bat"
	}

	return runCommand(ctx, packageRoot, environment, filepath.Join(packageRoot, wrapper), args...)
}

func jetbrainsPackageRoot(root string) string {
	return filepath.Join(root, "extensions", "jetbrains")
}

func jetbrainsGeneratedRoot(root string) string {
	return filepath.Join(jetbrainsPackageRoot(root), "build", "generated", "ferretd")
}

func jetbrainsArchivePath(root string) (string, error) {
	distributionRoot := filepath.Join(jetbrainsPackageRoot(root), "build", "distributions")
	matches, err := filepath.Glob(filepath.Join(distributionRoot, "ferret-jetbrains-*.zip"))
	if err != nil {
		return "", err
	}

	if len(matches) != 1 {
		return "", fmt.Errorf("expected exactly one JetBrains plugin archive in %s, found %d", distributionRoot, len(matches))
	}

	return matches[0], nil
}

func cleanJetBrains(root string) error {
	return os.RemoveAll(filepath.Join(jetbrainsPackageRoot(root), "build"))
}
