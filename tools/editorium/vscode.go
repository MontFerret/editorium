package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

const (
	maximumVSIXEntrySize       = 128 * 1024 * 1024
	vscodeMarketplaceName      = "ferret"
	vscodeMarketplacePublisher = "ferretlang"
)

type vscodeTarget struct {
	ID           string `json:"target,omitempty"`
	Platform     string `json:"-"`
	Architecture string `json:"-"`
	Artifact     string `json:"-"`
	ArchiveType  string `json:"-"`
	BinaryName   string `json:"-"`
	Runner       string `json:"runner,omitempty"`
	Unix         bool   `json:"-"`
}

var vscodeTargets = []vscodeTarget{
	{ID: "darwin-arm64", Platform: "darwin", Architecture: "arm64", Artifact: "ferretd_darwin_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Runner: "macos-14", Unix: true},
	{ID: "darwin-x64", Platform: "darwin", Architecture: "amd64", Artifact: "ferretd_darwin_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Runner: "macos-15-intel", Unix: true},
	{ID: "linux-x64", Platform: "linux", Architecture: "amd64", Artifact: "ferretd_linux_x86_64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Runner: "ubuntu-24.04", Unix: true},
	{ID: "linux-arm64", Platform: "linux", Architecture: "arm64", Artifact: "ferretd_linux_arm64.tar.gz", ArchiveType: "tar.gz", BinaryName: "ferretd", Runner: "ubuntu-24.04-arm", Unix: true},
	{ID: "win32-x64", Platform: "windows", Architecture: "amd64", Artifact: "ferretd_windows_x86_64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Runner: "windows-2025", Unix: false},
	{ID: "win32-arm64", Platform: "windows", Architecture: "arm64", Artifact: "ferretd_windows_arm64.zip", ArchiveType: "zip", BinaryName: "ferretd.exe", Runner: "windows-11-arm", Unix: false},
}

type vscodeManifest struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Publisher string `json:"publisher"`
}

type preparedTarget struct {
	Acquired     acquiredFerretd
	StagedBinary string
}

type packagedTarget struct {
	Prepared preparedTarget
	VSIXPath string
}

func extensionNames() []string {
	return []string{"vscode"}
}

func validateExtensions(names []string) error {
	available := extensionNames()
	known := make(map[string]struct{}, len(available))
	for _, name := range available {
		known[name] = struct{}{}
	}
	seen := make(map[string]struct{})
	for _, name := range names {
		if _, ok := known[name]; !ok {
			return usageError(fmt.Sprintf("unknown extension: %s", name))
		}
		if _, duplicate := seen[name]; duplicate {
			return usageError(fmt.Sprintf("extension may only be specified once: %s", name))
		}
		seen[name] = struct{}{}
	}
	return nil
}

func runExtensions(ctx context.Context, root, operation string, names []string) error {
	switch operation {
	case "prepare", "build", "test", "lint", "clean":
	default:
		return fmt.Errorf("unknown integration operation %q", operation)
	}
	unscoped := len(names) == 0
	if unscoped {
		names = extensionNames()
	}
	if err := validateExtensions(names); err != nil {
		return err
	}
	for _, name := range names {
		fmt.Printf("Running %s for extension %q\n", operation, name)
		switch name {
		case "vscode":
			if err := runVSCodeOperation(ctx, root, operation); err != nil {
				return err
			}
		}
	}
	if operation == "clean" && unscoped {
		for _, path := range []string{
			filepath.Join(root, ".dist"),
			filepath.Join(root, "shared", "proto", "ferretd"),
		} {
			if err := os.RemoveAll(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func runExplicitExtension(ctx context.Context, root, operation, name string) error {
	if err := validateExtensions([]string{name}); err != nil {
		return err
	}
	if name != "vscode" {
		return fmt.Errorf("extension %q does not implement %s", name, operation)
	}
	target, err := selectedTarget()
	if err != nil {
		return err
	}
	switch operation {
	case "package":
		_, err = packageVSCodeTarget(ctx, root, target)
	case "package-check":
		err = checkVSCodeTarget(ctx, root, target)
	case "install":
		var packaged packagedTarget
		packaged, err = packageVSCodeTarget(ctx, root, target)
		if err == nil {
			err = installVSCodeTarget(ctx, root, packaged)
		}
	case "matrix":
		matrix := struct {
			Include []vscodeTarget `json:"include"`
		}{Include: vscodeTargets}
		var encoded []byte
		encoded, err = json.Marshal(matrix)
		if err == nil {
			fmt.Println(string(encoded))
		}
	case "test-installed":
		err = testInstalledVSIX(ctx, root, target)
	default:
		err = fmt.Errorf("unsupported explicit operation %q", operation)
	}
	return err
}

func runVSCodeOperation(ctx context.Context, root, operation string) error {
	switch operation {
	case "prepare":
		force, err := envBool("FORCE")
		if err != nil {
			return err
		}
		if _, err := syncFerretdProto(ctx, root, force, nil); err != nil {
			return err
		}
		target, err := selectedTarget()
		if err != nil {
			return err
		}
		_, err = prepareVSCodeTarget(ctx, root, target)
		return err
	case "build":
		return runCommand(ctx, vscodePackageRoot(root), nil, executableName("npm"), "run", "build")
	case "test":
		if _, err := syncFerretdProto(ctx, root, false, nil); err != nil {
			return err
		}
		if err := generateVSCodeProto(ctx, root, true); err != nil {
			return err
		}
		target, err := selectedTarget()
		if err != nil {
			return err
		}
		prepared, err := prepareVSCodeTarget(ctx, root, target)
		if err != nil {
			return err
		}
		packageRoot := vscodePackageRoot(root)
		if err := runCommand(ctx, packageRoot, nil, executableName("npm"), "test"); err != nil {
			return err
		}
		return runCommand(ctx, packageRoot, []string{"FERRETD_TEST_PATH=" + prepared.StagedBinary}, executableName("npm"), "run", "test:integration")
	case "lint":
		if _, err := syncFerretdProto(ctx, root, false, nil); err != nil {
			return err
		}
		if err := generateVSCodeProto(ctx, root, true); err != nil {
			return err
		}
		return runCommand(ctx, vscodePackageRoot(root), nil, executableName("npm"), "run", "lint")
	case "clean":
		return cleanVSCode(root)
	default:
		return fmt.Errorf("unknown VS Code operation %q", operation)
	}
}

func selectedTarget() (vscodeTarget, error) {
	requested := strings.TrimSpace(os.Getenv("TARGET"))
	if requested == "" {
		return detectHostTarget(runtime.GOOS, runtime.GOARCH)
	}
	return resolveTarget(requested)
}

func detectHostTarget(goos, goarch string) (vscodeTarget, error) {
	for _, target := range vscodeTargets {
		if target.Platform == goos && target.Architecture == goarch {
			return target, nil
		}
	}
	return vscodeTarget{}, fmt.Errorf("unsupported host platform %s-%s; supported targets: %s", goos, goarch, strings.Join(targetIDs(), ", "))
}

func resolveTarget(id string) (vscodeTarget, error) {
	for _, target := range vscodeTargets {
		if target.ID == id {
			return target, nil
		}
	}
	return vscodeTarget{}, fmt.Errorf("unsupported VS Code target %s; supported targets: %s", id, strings.Join(targetIDs(), ", "))
}

func targetIDs() []string {
	ids := make([]string, 0, len(vscodeTargets))
	for _, target := range vscodeTargets {
		ids = append(ids, target.ID)
	}
	return ids
}

func prepareVSCodeTarget(ctx context.Context, root string, target vscodeTarget) (preparedTarget, error) {
	if runtime.GOOS == "windows" && target.Unix {
		return preparedTarget{}, fmt.Errorf("cannot package Unix target %s on Windows because vsce does not preserve POSIX executable permissions", target.ID)
	}
	acquired, err := acquireFerretd(ctx, root, target, nil)
	if err != nil {
		return preparedTarget{}, err
	}
	stageRoot, err := os.MkdirTemp(filepath.Join(root, ".dist"), "staging-")
	if err != nil {
		return preparedTarget{}, err
	}
	defer os.RemoveAll(stageRoot)
	temporaryBin := filepath.Join(stageRoot, "bin")
	mode := os.FileMode(0o644)
	if target.Unix {
		mode = 0o755
	}
	staged := filepath.Join(temporaryBin, target.BinaryName)
	if err := copyFileAtomic(acquired.BinaryPath, staged, mode); err != nil {
		return preparedTarget{}, err
	}
	finalBin := filepath.Join(vscodePackageRoot(root), "bin")
	if err := os.RemoveAll(finalBin); err != nil {
		return preparedTarget{}, err
	}
	if err := os.Rename(temporaryBin, finalBin); err != nil {
		return preparedTarget{}, err
	}
	finalBinary := filepath.Join(finalBin, target.BinaryName)
	if isNativeTarget(target) {
		if err := smokeFerretd(ctx, finalBinary, acquired.Version); err != nil {
			return preparedTarget{}, err
		}
	} else {
		fmt.Printf("Skipped execution smoke test for foreign target %s.\n", target.ID)
	}
	fmt.Printf("Prepared ferretd %s for %s: %s\n", acquired.Version, target.ID, finalBinary)
	return preparedTarget{Acquired: acquired, StagedBinary: finalBinary}, nil
}

func packageVSCodeTarget(ctx context.Context, root string, target vscodeTarget) (packagedTarget, error) {
	prepared, err := prepareVSCodeTarget(ctx, root, target)
	if err != nil {
		return packagedTarget{}, err
	}
	manifest, err := readVSCodeManifest(root)
	if err != nil {
		return packagedTarget{}, err
	}
	packageRoot := vscodePackageRoot(root)
	distributionRoot := vscodeDistributionRoot(root)
	if err := os.MkdirAll(distributionRoot, 0o755); err != nil {
		return packagedTarget{}, err
	}
	vsixPath := vscodeVSIXPath(root, manifest.Version, target)
	vsce := filepath.Join(packageRoot, "node_modules", "@vscode", "vsce", "vsce")
	if err := runCommand(ctx, packageRoot, nil, "node", vsce, "package", "--target", target.ID, "--no-dependencies", "--out", vsixPath); err != nil {
		return packagedTarget{}, err
	}
	if _, err := validateVSIX(ctx, vsixPath, target, prepared.StagedBinary, prepared.Acquired.Version, manifest); err != nil {
		return packagedTarget{}, err
	}
	fmt.Printf("Packaged and verified %s: %s\n", target.ID, vsixPath)
	return packagedTarget{Prepared: prepared, VSIXPath: vsixPath}, nil
}

func checkVSCodeTarget(ctx context.Context, root string, target vscodeTarget) error {
	version, err := readFerretdVersion(root)
	if err != nil {
		return err
	}
	manifest, err := readVSCodeManifest(root)
	if err != nil {
		return err
	}
	packageRoot := vscodePackageRoot(root)
	path := vscodeVSIXPath(root, manifest.Version, target)
	staged := filepath.Join(packageRoot, "bin", target.BinaryName)
	if _, err := validateVSIX(ctx, path, target, staged, version, manifest); err != nil {
		return err
	}
	fmt.Printf("Verified %s\n", path)
	return nil
}

func validateVSIX(ctx context.Context, path string, target vscodeTarget, stagedBinary, version string, manifest vscodeManifest) (string, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	binaryEntry := "extension/bin/" + target.BinaryName
	expected := []string{
		"[Content_Types].xml", "extension.vsixmanifest", "extension/LICENSE.txt", binaryEntry,
		"extension/language-configuration.json", "extension/out/extension.js", "extension/package.json",
		"extension/readme.md", "extension/media/icon.png", "extension/syntaxes/ferret.tmLanguage.json",
	}
	sort.Strings(expected)
	entries := make(map[string]*zip.File)
	for _, file := range archive.File {
		if _, duplicate := entries[file.Name]; duplicate {
			return "", fmt.Errorf("duplicate VSIX entry: %s", file.Name)
		}
		entries[file.Name] = file
	}
	actual := make([]string, 0, len(entries))
	for name := range entries {
		actual = append(actual, name)
	}
	sort.Strings(actual)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		return "", fmt.Errorf("unexpected VSIX contents in %s: got %v, want %v", path, actual, expected)
	}
	manifestBytes, err := readZipEntry(entries["extension.vsixmanifest"])
	if err != nil {
		return "", err
	}
	targetPattern := regexp.MustCompile(`\bTargetPlatform="([^"]+)"`)
	matches := targetPattern.FindSubmatch(manifestBytes)
	if len(matches) != 2 || string(matches[1]) != target.ID {
		return "", fmt.Errorf("VSIX target platform does not match requested target %s", target.ID)
	}
	packageBytes, err := readZipEntry(entries["extension/package.json"])
	if err != nil {
		return "", err
	}
	var packagedManifest vscodeManifest
	if err := json.Unmarshal(packageBytes, &packagedManifest); err != nil {
		return "", err
	}
	if packagedManifest.Name != manifest.Name || packagedManifest.Version != manifest.Version || packagedManifest.Publisher != manifest.Publisher {
		return "", fmt.Errorf("packaged manifest identity does not match source manifest")
	}
	binaryBytes, err := readZipEntry(entries[binaryEntry])
	if err != nil {
		return "", err
	}
	stagedBytes, err := os.ReadFile(stagedBinary)
	if err != nil {
		return "", err
	}
	if !bytes.Equal(binaryBytes, stagedBytes) {
		return "", fmt.Errorf("packaged daemon bytes differ from verified staged daemon")
	}
	if target.Unix && entries[binaryEntry].Mode().Perm() != 0o755 {
		return "", fmt.Errorf("packaged %s mode is not 0755", target.BinaryName)
	}
	if isNativeTarget(target) {
		temporary, err := os.MkdirTemp("", "ferret-vsix-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(temporary)
		extracted := filepath.Join(temporary, target.BinaryName)
		mode := os.FileMode(0o644)
		if target.Unix {
			mode = 0o755
		}
		if err := os.WriteFile(extracted, binaryBytes, mode); err != nil {
			return "", err
		}
		if err := smokeFerretd(ctx, extracted, version); err != nil {
			return "", err
		}
	}
	digest := sha256.Sum256(binaryBytes)
	return hex.EncodeToString(digest[:]), nil
}

func readZipEntry(file *zip.File) ([]byte, error) {
	if file == nil {
		return nil, fmt.Errorf("missing VSIX entry")
	}
	if file.UncompressedSize64 > maximumVSIXEntrySize || !file.Mode().IsRegular() {
		return nil, fmt.Errorf("VSIX entry is not a bounded regular file: %s", file.Name)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var buffer bytes.Buffer
	if err := copyLimited(&buffer, reader, maximumVSIXEntrySize, "VSIX entry"); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func smokeFerretd(ctx context.Context, path, version string) error {
	command := exec.CommandContext(ctx, path, "--version")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s --version failed: %w", filepath.Base(path), err)
	}
	expected := "ferretd " + version
	if strings.TrimSpace(stdout.String()) != expected || strings.TrimSpace(stderr.String()) != "" {
		return fmt.Errorf("%s --version returned stdout %q and stderr %q; expected %q", filepath.Base(path), stdout.String(), stderr.String(), expected)
	}
	return nil
}

func installVSCodeTarget(ctx context.Context, root string, packaged packagedTarget) error {
	command := strings.TrimSpace(os.Getenv("CODE"))
	if command == "" {
		command = "code"
	}
	if err := runCommand(ctx, vscodePackageRoot(root), nil, command, "--install-extension", packaged.VSIXPath, "--force"); err != nil {
		if _, lookErr := exec.LookPath(command); lookErr != nil {
			return fmt.Errorf("VS Code CLI %q was not found; install %s manually with: %s --install-extension %q --force", command, packaged.VSIXPath, command, packaged.VSIXPath)
		}
		return err
	}
	fmt.Printf("Installed %s\n", packaged.VSIXPath)
	return nil
}

func testInstalledVSIX(ctx context.Context, root string, target vscodeTarget) error {
	manifest, err := readVSCodeManifest(root)
	if err != nil {
		return err
	}
	packageRoot := vscodePackageRoot(root)
	path := vscodeVSIXPath(root, manifest.Version, target)
	return runCommand(ctx, packageRoot, []string{"FERRET_VSIX_PATH=" + path}, executableName("npm"), "run", "test:installed")
}

func readVSCodeManifest(root string) (vscodeManifest, error) {
	path := filepath.Join(vscodePackageRoot(root), "package.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		return vscodeManifest{}, err
	}
	var manifest vscodeManifest
	if err := json.Unmarshal(contents, &manifest); err != nil {
		return vscodeManifest{}, err
	}
	if manifest.Name != vscodeMarketplaceName || !validVersion(manifest.Version) {
		return vscodeManifest{}, fmt.Errorf("invalid VS Code package manifest: %s", path)
	}
	if manifest.Publisher != vscodeMarketplacePublisher {
		return vscodeManifest{}, fmt.Errorf("VS Code package publisher %q does not match Marketplace publisher %q", manifest.Publisher, vscodeMarketplacePublisher)
	}
	return manifest, nil
}

func vscodePackageRoot(root string) string {
	return filepath.Join(root, "extensions", "vscode")
}

func vscodeDistributionRoot(root string) string {
	return filepath.Join(vscodePackageRoot(root), "dist")
}

func vscodeVSIXPath(root, version string, target vscodeTarget) string {
	return filepath.Join(vscodeDistributionRoot(root), vsixFilename(version, target))
}

func vsixFilename(version string, target vscodeTarget) string {
	return fmt.Sprintf("ferret-vscode-%s-%s.vsix", version, target.ID)
}

func isNativeTarget(target vscodeTarget) bool {
	return target.Platform == runtime.GOOS && target.Architecture == runtime.GOARCH
}

func cleanVSCode(root string) error {
	packageRoot := vscodePackageRoot(root)
	for _, directory := range []string{"out", "bin", ".vscode-test", "dist"} {
		if err := os.RemoveAll(filepath.Join(packageRoot, directory)); err != nil {
			return err
		}
	}
	return nil
}
