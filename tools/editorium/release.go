package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/mod/semver"
)

const (
	releaseRemote = "origin"
	releaseBranch = "main"
)

type releaseMetadata struct {
	Tag                 string `json:"tag"`
	Version             string `json:"version"`
	Prerelease          bool   `json:"prerelease"`
	MarketplaceEligible bool   `json:"marketplace_eligible"`
	Title               string `json:"title"`
}

type githubRelease struct {
	TagName      string `json:"tagName"`
	Name         string `json:"name"`
	IsDraft      bool   `json:"isDraft"`
	IsPrerelease bool   `json:"isPrerelease"`
	Assets       []struct {
		Name string `json:"name"`
	} `json:"assets"`
}

func runRelease(ctx context.Context, root, extension, version string) error {
	return runReleaseWithValidator(ctx, root, extension, version, validateReleaseBuild)
}

func runReleaseWithValidator(ctx context.Context, root, extension, version string, validate func(context.Context, string, string) error) error {
	if err := validateExtensions([]string{extension}); err != nil {
		return err
	}
	metadata, err := resolveReleaseMetadata(extension, version, root)
	if err != nil {
		return err
	}
	head, err := requireReleaseRepositoryState(ctx, root, extension)
	if err != nil {
		return err
	}
	if err := requireTrackedManifest(ctx, root, extension); err != nil {
		return err
	}
	if err := assertTagAvailable(ctx, root, metadata.Tag); err != nil {
		return err
	}

	fmt.Printf("Extension: %s\nVersion:   %s\nTag:       %s\n", extension, version, metadata.Tag)
	if err := validate(ctx, root, extension); err != nil {
		return err
	}
	currentHead, err := requireReleaseRepositoryState(ctx, root, extension)
	if err != nil {
		return err
	}
	if currentHead != head {
		return fmt.Errorf("release validation changed HEAD from %s to %s", head, currentHead)
	}
	if err := assertTagAvailable(ctx, root, metadata.Tag); err != nil {
		return err
	}
	if err := runCommand(ctx, root, nil, "git", "tag", "-a", metadata.Tag, "-m", "Release "+metadata.Tag); err != nil {
		return err
	}
	pushErr := runCommand(ctx, root, nil, "git", "push", releaseRemote, "refs/tags/"+metadata.Tag+":refs/tags/"+metadata.Tag)
	if pushErr != nil {
		return reconcileFailedTagPush(ctx, root, metadata.Tag, head, pushErr)
	}
	fmt.Printf("Created and pushed annotated tag %s.\n", metadata.Tag)
	return nil
}

func reconcileFailedTagPush(ctx context.Context, root, tag, head string, pushErr error) error {
	landed, confirmErr := remoteTagCommit(ctx, root, tag)
	if confirmErr == nil && landed == head {
		fmt.Println("Tag push completed despite a local transport error; confirmed the remote ref.")
		return nil
	}
	_ = runCommand(ctx, root, nil, "git", "tag", "-d", tag)
	if confirmErr != nil {
		return fmt.Errorf("tag push failed and remote state could not be confirmed: %w", pushErr)
	}
	return fmt.Errorf("tag push failed; removed local tag %s: %w", tag, pushErr)
}

func resolveReleaseMetadata(extension, version, root string) (releaseMetadata, error) {
	if !validVersion(version) {
		return releaseMetadata{}, fmt.Errorf("invalid release version %q; expected canonical SemVer", version)
	}
	if extension != "vscode" {
		return releaseMetadata{}, fmt.Errorf("extension %q does not implement releases", extension)
	}
	manifest, err := readVSCodeManifest(root)
	if err != nil {
		return releaseMetadata{}, err
	}
	if manifest.Version != version {
		return releaseMetadata{}, fmt.Errorf("release version %s does not match extensions/vscode/package.json version %s", version, manifest.Version)
	}
	tag := extension + "/v" + version
	return releaseMetadata{
		Tag:                 tag,
		Version:             version,
		Prerelease:          semver.Prerelease("v"+version) != "",
		MarketplaceEligible: marketplaceVersionEligible(version),
		Title:               "Ferret VS Code " + version,
	}, nil
}

func marketplaceVersionEligible(version string) bool {
	canonical := "v" + version
	return validVersion(version) && semver.Prerelease(canonical) == "" && semver.Build(canonical) == ""
}

func requireReleaseRepositoryState(ctx context.Context, root, extension string) (string, error) {
	top, err := gitOutput(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("releases must run from a Git repository: %w", err)
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	resolvedTop, _ := filepath.EvalSymlinks(top)
	if resolvedRoot != resolvedTop {
		return "", fmt.Errorf("releases must run from repository root %s", top)
	}
	status, err := gitOutput(ctx, root, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return "", err
	}
	if status != "" {
		return "", fmt.Errorf("releases require a clean working tree")
	}
	branch, err := gitOutput(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return "", fmt.Errorf("releases cannot run from a detached HEAD")
	}
	if branch != releaseBranch {
		return "", fmt.Errorf("releases must run from %q, not %q", releaseBranch, branch)
	}
	remoteMainRef := fmt.Sprintf("refs/release-remotes/%s/%s", releaseRemote, releaseBranch)
	remoteTagRoot := fmt.Sprintf("refs/release-remote-tags/%s/*", extension)
	remoteTagSource := fmt.Sprintf("+refs/tags/%s/*:%s", extension, remoteTagRoot)
	if err := runCommand(ctx, root, nil, "git", "fetch", "--no-tags", "--prune", releaseRemote,
		"+refs/heads/"+releaseBranch+":"+remoteMainRef, remoteTagSource); err != nil {
		return "", err
	}
	upstream, err := gitOutput(ctx, root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err != nil || upstream != releaseRemote+"/"+releaseBranch {
		return "", fmt.Errorf("branch %q must track %q", releaseBranch, releaseRemote+"/"+releaseBranch)
	}
	head, err := gitOutput(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	remoteHead, err := gitOutput(ctx, root, "rev-parse", remoteMainRef)
	if err != nil {
		return "", err
	}
	if head != remoteHead {
		return "", fmt.Errorf("branch %q must be synchronized with %q", releaseBranch, releaseRemote+"/"+releaseBranch)
	}
	return head, nil
}

func requireTrackedManifest(ctx context.Context, root, extension string) error {
	manifest := filepath.ToSlash(filepath.Join("extensions", extension, "package.json"))
	if _, err := gitOutput(ctx, root, "ls-files", "--error-unmatch", manifest); err != nil {
		return fmt.Errorf("release manifest is not tracked: %s", manifest)
	}
	tracked, err := gitOutput(ctx, root, "rev-parse", "HEAD:"+manifest)
	if err != nil {
		return err
	}
	working, err := gitOutput(ctx, root, "hash-object", "--path="+manifest, manifest)
	if err != nil {
		return err
	}
	if tracked != working {
		return fmt.Errorf("release manifest differs from the tracked HEAD version: %s", manifest)
	}
	return nil
}

func assertTagAvailable(ctx context.Context, root, tag string) error {
	if err := runCommand(ctx, root, nil, "git", "check-ref-format", "refs/tags/"+tag); err != nil {
		return fmt.Errorf("invalid release tag %s: %w", tag, err)
	}
	local, err := gitRefExists(ctx, root, "refs/tags/"+tag)
	if err != nil {
		return err
	}
	if local {
		return fmt.Errorf("tag already exists locally: %s", tag)
	}
	remoteRef := "refs/release-remote-tags/" + tag
	remote, err := gitRefExists(ctx, root, remoteRef)
	if err != nil {
		return err
	}
	if remote {
		return fmt.Errorf("tag already exists on %s: %s", releaseRemote, tag)
	}
	return nil
}

func validateReleaseBuild(ctx context.Context, root, extension string) error {
	toolRoot := filepath.Join(root, "tools", "editorium")
	if err := runCommand(ctx, toolRoot, nil, "go", "test", "./..."); err != nil {
		return err
	}
	if err := runCommand(ctx, toolRoot, nil, "go", "vet", "./..."); err != nil {
		return err
	}
	formatted, err := gofmtDifferences(ctx, root)
	if err != nil {
		return err
	}
	if len(formatted) > 0 {
		return fmt.Errorf("go files are not formatted:\n%s", strings.Join(formatted, "\n"))
	}
	for _, operation := range []string{"prepare", "build", "lint", "test"} {
		if err := runExtensions(ctx, root, operation, []string{extension}); err != nil {
			return err
		}
	}
	if err := runExplicitExtension(ctx, root, "package", extension); err != nil {
		return err
	}
	return runExplicitExtension(ctx, root, "package-check", extension)
}

func gofmtDifferences(ctx context.Context, root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(filepath.Join(root, "tools", "editorium"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".go") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}
	output, err := commandOutput(ctx, root, nil, "gofmt", append([]string{"-l"}, files...)...)
	if err != nil {
		return nil, err
	}
	var result []string
	for _, path := range strings.Fields(output) {
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil, relErr
		}
		result = append(result, filepath.ToSlash(relative))
	}
	return result, nil
}

func gitOutput(ctx context.Context, root string, args ...string) (string, error) {
	output, err := commandOutput(ctx, root, nil, "git", args...)
	return strings.TrimSpace(output), err
}

func gitRefExists(ctx context.Context, root, ref string) (bool, error) {
	_, err := commandOutput(ctx, root, nil, "git", "show-ref", "--verify", "--quiet", ref)
	if err == nil {
		return true, nil
	}
	// show-ref uses status 1 for an absent ref.
	if strings.Contains(err.Error(), "exit status 1") {
		return false, nil
	}
	return false, err
}

func remoteTagCommit(ctx context.Context, root, tag string) (string, error) {
	output, err := gitOutput(ctx, root, "ls-remote", releaseRemote, "refs/tags/"+tag+"^{}")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(output)
	if len(fields) == 0 {
		return "", nil
	}
	return fields[0], nil
}

func runReleaseCI(root string, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("release-ci requires metadata, check-assets, or state\n%s", usage)
	}
	flags := flag.NewFlagSet("release-ci "+args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	tag := flags.String("tag", "", "release tag")
	format := flags.String("format", "json", "metadata output format")
	directory := flags.String("directory", "", "release asset directory")
	releaseJSON := flags.String("release-json", "", "existing release JSON")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if *tag == "" {
		return fmt.Errorf("missing required release option: --tag")
	}
	metadata, err := metadataFromTag(root, *tag)
	if err != nil {
		return err
	}
	switch args[0] {
	case "metadata":
		switch *format {
		case "json":
			encoded, err := json.Marshal(metadata)
			if err != nil {
				return err
			}
			fmt.Println(string(encoded))
		case "github":
			fmt.Printf("version=%s\nprerelease=%t\nmarketplace_eligible=%t\ntitle=%s\n", metadata.Version, metadata.Prerelease, metadata.MarketplaceEligible, metadata.Title)
		default:
			return fmt.Errorf("unknown metadata format: %s", *format)
		}
	case "check-assets":
		if *directory == "" {
			return fmt.Errorf("missing required release option: --directory")
		}
		assets, err := validateReleaseAssets(*directory, metadata.Version)
		if err != nil {
			return err
		}
		fmt.Printf("Verified %d release assets in %s.\n", len(assets), *directory)
	case "state":
		var release *githubRelease
		if *releaseJSON != "" {
			var decoded githubRelease
			if err := json.Unmarshal([]byte(*releaseJSON), &decoded); err != nil {
				return err
			}
			release = &decoded
		}
		action, err := decideReleaseAction(release, metadata)
		if err != nil {
			return err
		}
		fmt.Println(action)
	default:
		return fmt.Errorf("unknown release-ci operation %q", args[0])
	}
	return nil
}

func metadataFromTag(root, tag string) (releaseMetadata, error) {
	const prefix = "vscode/v"
	if !strings.HasPrefix(tag, prefix) {
		return releaseMetadata{}, fmt.Errorf("invalid VS Code release tag %q; expected %s<semver>", tag, prefix)
	}
	version := strings.TrimPrefix(tag, prefix)
	metadata, err := resolveReleaseMetadata("vscode", version, root)
	if err != nil {
		return releaseMetadata{}, err
	}
	if metadata.Tag != tag {
		return releaseMetadata{}, fmt.Errorf("invalid VS Code release tag %q", tag)
	}
	return metadata, nil
}

func expectedReleaseAssetNames(version string) []string {
	result := make([]string, 0, len(vscodeTargets))
	for _, target := range vscodeTargets {
		result = append(result, vsixFilename(version, target))
	}
	sort.Strings(result)
	return result
}

func validateReleaseAssets(directory, version string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	expected := expectedReleaseAssetNames(version)
	actual := make([]string, 0, len(entries))
	entryByName := make(map[string]os.DirEntry)
	for _, entry := range entries {
		actual = append(actual, entry.Name())
		entryByName[entry.Name()] = entry
	}
	sort.Strings(actual)
	missing, unexpected := stringSetDifference(expected, actual), stringSetDifference(actual, expected)
	if len(missing) > 0 || len(unexpected) > 0 {
		encoded, _ := json.Marshal(map[string][]string{"missing": missing, "unexpected": unexpected})
		return nil, fmt.Errorf("release asset set does not match supported VS Code targets: %s", encoded)
	}
	paths := make([]string, 0, len(expected))
	for _, name := range expected {
		entry := entryByName[name]
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		path := filepath.Join(directory, name)
		if !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, fmt.Errorf("release asset is not a non-empty file: %s", path)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func decideReleaseAction(release *githubRelease, metadata releaseMetadata) (string, error) {
	if release == nil {
		return "create", nil
	}
	if release.TagName != metadata.Tag {
		return "", fmt.Errorf("existing release tag %q does not match %q", release.TagName, metadata.Tag)
	}
	if release.IsDraft {
		return "replace-draft", nil
	}
	var conflicts []string
	if release.Name != metadata.Title {
		conflicts = append(conflicts, fmt.Sprintf("title %q", release.Name))
	}
	if release.IsPrerelease != metadata.Prerelease {
		conflicts = append(conflicts, fmt.Sprintf("prerelease=%t", release.IsPrerelease))
	}
	actual := make([]string, 0, len(release.Assets))
	for _, asset := range release.Assets {
		actual = append(actual, asset.Name)
	}
	sort.Strings(actual)
	expected := expectedReleaseAssetNames(metadata.Version)
	if strings.Join(actual, "\n") != strings.Join(expected, "\n") {
		conflicts = append(conflicts, fmt.Sprintf("assets %v", actual))
	}
	if len(conflicts) > 0 {
		return "", fmt.Errorf("published release %s conflicts with the validated release: %s", metadata.Tag, strings.Join(conflicts, ", "))
	}
	return "noop", nil
}

func stringSetDifference(left, right []string) []string {
	rightSet := make(map[string]struct{}, len(right))
	for _, value := range right {
		rightSet[value] = struct{}{}
	}
	var result []string
	for _, value := range left {
		if _, ok := rightSet[value]; !ok {
			result = append(result, value)
		}
	}
	return result
}
