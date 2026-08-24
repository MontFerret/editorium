package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestReleaseMetadataAssetsAndPublishedState(t *testing.T) {
	root := t.TempDir()
	writeVSCodePackageManifest(t, root, "0.1.0")
	metadata, err := resolveReleaseMetadata("vscode", "0.1.0", root)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Tag != "vscode/v0.1.0" || metadata.Version != "0.1.0" || metadata.Prerelease || metadata.Title != "Ferret VS Code 0.1.0" {
		t.Fatalf("metadata = %#v", metadata)
	}
	writeVSCodePackageManifest(t, root, "0.2.0-beta.2")
	prerelease, err := resolveReleaseMetadata("vscode", "0.2.0-beta.2", root)
	if err != nil || !prerelease.Prerelease {
		t.Fatalf("prerelease metadata = %#v, %v", prerelease, err)
	}
	for _, version := range []string{"", "1.2", "01.2.3", "v1.2.3", "latest"} {
		if _, err := resolveReleaseMetadata("vscode", version, root); err == nil {
			t.Fatalf("accepted noncanonical version %q", version)
		}
	}
	if _, err := resolveReleaseMetadata("vscode", "0.1.0", root); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("manifest mismatch error = %v", err)
	}
	if _, err := metadataFromTag(root, "jetbrains/v0.2.0-beta.2"); err == nil {
		t.Fatal("accepted unrelated tag")
	}

	assets := expectedReleaseAssetNames("0.1.0")
	if len(assets) != 6 || !sort.StringsAreSorted(assets) {
		t.Fatalf("release assets = %v", assets)
	}
	directory := t.TempDir()
	for _, name := range assets {
		writeTestFile(t, filepath.Join(directory, name), []byte("vsix"), 0o644)
	}
	paths, err := validateReleaseAssets(directory, "0.1.0")
	if err != nil || len(paths) != 6 {
		t.Fatalf("validateReleaseAssets() = %v, %v", paths, err)
	}
	if action, err := decideReleaseAction(nil, metadata); err != nil || action != "create" {
		t.Fatalf("absent release action = %q, %v", action, err)
	}
	draft := matchingRelease(metadata)
	draft.IsDraft = true
	if action, err := decideReleaseAction(&draft, metadata); err != nil || action != "replace-draft" {
		t.Fatalf("draft release action = %q, %v", action, err)
	}
	matching := matchingRelease(metadata)
	if action, err := decideReleaseAction(&matching, metadata); err != nil || action != "noop" {
		t.Fatalf("matching release action = %q, %v", action, err)
	}
	matching.Name = "Wrong title"
	if _, err := decideReleaseAction(&matching, metadata); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("conflicting release error = %v", err)
	}
}

func TestValidateReleaseAssetsRejectsIncompleteSets(t *testing.T) {
	directory := t.TempDir()
	names := expectedReleaseAssetNames("0.1.0")
	for _, name := range names[1:] {
		writeTestFile(t, filepath.Join(directory, name), []byte("vsix"), 0o644)
	}
	writeTestFile(t, filepath.Join(directory, "unexpected.vsix"), []byte("vsix"), 0o644)
	if _, err := validateReleaseAssets(directory, "0.1.0"); err == nil || !strings.Contains(err.Error(), "missing") || !strings.Contains(err.Error(), "unexpected") {
		t.Fatalf("incomplete asset error = %v", err)
	}
	if err := os.Remove(filepath.Join(directory, "unexpected.vsix")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(directory, names[0]), nil, 0o644)
	if _, err := validateReleaseAssets(directory, "0.1.0"); err == nil || !strings.Contains(err.Error(), "non-empty") {
		t.Fatalf("empty asset error = %v", err)
	}
}

func TestReleaseRepositoryPreflightRejectsInvalidStatesAndExistingTags(t *testing.T) {
	ctx := context.Background()
	t.Run("dirty", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		writeTestFile(t, filepath.Join(fixture.work, "dirty.txt"), []byte("dirty"), 0o644)
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err == nil || !strings.Contains(err.Error(), "clean working tree") {
			t.Fatalf("dirty error = %v", err)
		}
	})
	t.Run("detached", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		fixture.git(t, "checkout", "--detach")
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err == nil || !strings.Contains(err.Error(), "detached") {
			t.Fatalf("detached error = %v", err)
		}
	})
	t.Run("wrong branch", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		fixture.git(t, "switch", "-c", "feature")
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err == nil || !strings.Contains(err.Error(), `must run from "main"`) {
			t.Fatalf("branch error = %v", err)
		}
	})
	t.Run("out of sync", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		writeTestFile(t, filepath.Join(fixture.work, "ahead.txt"), []byte("ahead"), 0o644)
		fixture.git(t, "add", "ahead.txt")
		fixture.git(t, "commit", "-m", "ahead")
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err == nil || !strings.Contains(err.Error(), "synchronized") {
			t.Fatalf("out-of-sync error = %v", err)
		}
	})
	t.Run("local tag", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err != nil {
			t.Fatal(err)
		}
		fixture.git(t, "tag", "vscode/v0.1.0")
		if err := assertTagAvailable(ctx, fixture.work, "vscode/v0.1.0"); err == nil || !strings.Contains(err.Error(), "locally") {
			t.Fatalf("local tag error = %v", err)
		}
	})
	t.Run("remote tag", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		fixture.git(t, "tag", "vscode/v0.1.0")
		fixture.git(t, "push", "origin", "refs/tags/vscode/v0.1.0")
		fixture.git(t, "tag", "-d", "vscode/v0.1.0")
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err != nil {
			t.Fatal(err)
		}
		if err := assertTagAvailable(ctx, fixture.work, "vscode/v0.1.0"); err == nil || !strings.Contains(err.Error(), "origin") {
			t.Fatalf("remote tag error = %v", err)
		}
	})
	t.Run("tracked manifest equality", func(t *testing.T) {
		fixture := newReleaseGitFixture(t)
		fixture.git(t, "update-index", "--assume-unchanged", "extensions/vscode/package.json")
		writeVSCodePackageManifest(t, fixture.work, "0.2.0")
		if _, err := requireReleaseRepositoryState(ctx, fixture.work, "vscode"); err != nil {
			t.Fatal(err)
		}
		if err := requireTrackedManifest(ctx, fixture.work, "vscode"); err == nil || !strings.Contains(err.Error(), "differs from the tracked HEAD") {
			t.Fatalf("tracked manifest error = %v", err)
		}
	})
}

func TestReleasePushesAnnotatedTagAtUnchangedHead(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	ctx := context.Background()
	head := fixture.git(t, "rev-parse", "HEAD")
	err := runReleaseWithValidator(ctx, fixture.work, "vscode", "0.1.0", func(context.Context, string, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if got := fixture.git(t, "rev-parse", "HEAD"); got != head {
		t.Fatalf("HEAD changed from %s to %s", head, got)
	}
	if objectType := fixture.git(t, "cat-file", "-t", "refs/tags/vscode/v0.1.0"); objectType != "tag" {
		t.Fatalf("tag object type = %s", objectType)
	}
	if commit := fixture.git(t, "rev-parse", "refs/tags/vscode/v0.1.0^{}"); commit != head {
		t.Fatalf("local tag commit = %s, want %s", commit, head)
	}
	if commit := bareGit(t, fixture.remote, "rev-parse", "refs/tags/vscode/v0.1.0^{}"); commit != head {
		t.Fatalf("remote tag commit = %s, want %s", commit, head)
	}
}

func TestReleaseValidationFailureCreatesNoTag(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	err := runReleaseWithValidator(context.Background(), fixture.work, "vscode", "0.1.0", func(context.Context, string, string) error {
		return errors.New("validation failed")
	})
	if err == nil || !strings.Contains(err.Error(), "validation failed") {
		t.Fatalf("release error = %v", err)
	}
	assertMissingGitRef(t, fixture.work, "refs/tags/vscode/v0.1.0")
	assertMissingBareGitRef(t, fixture.remote, "refs/tags/vscode/v0.1.0")
}

func TestReleasePushFailureRollsBackLocalTag(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	hook := filepath.Join(fixture.remote, "hooks", "pre-receive")
	writeTestFile(t, hook, []byte("#!/bin/sh\nexit 1\n"), 0o755)
	err := runReleaseWithValidator(context.Background(), fixture.work, "vscode", "0.1.0", func(context.Context, string, string) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "removed local tag") {
		t.Fatalf("release error = %v", err)
	}
	assertMissingGitRef(t, fixture.work, "refs/tags/vscode/v0.1.0")
	assertMissingBareGitRef(t, fixture.remote, "refs/tags/vscode/v0.1.0")
}

func TestFailedPushReconciliationKeepsConfirmedRemoteTag(t *testing.T) {
	fixture := newReleaseGitFixture(t)
	fixture.git(t, "tag", "-a", "vscode/v0.1.0", "-m", "Release vscode/v0.1.0")
	fixture.git(t, "push", "origin", "refs/tags/vscode/v0.1.0")
	head := fixture.git(t, "rev-parse", "HEAD")
	if err := reconcileFailedTagPush(context.Background(), fixture.work, "vscode/v0.1.0", head, errors.New("injected transport error")); err != nil {
		t.Fatal(err)
	}
	if got := fixture.git(t, "rev-parse", "refs/tags/vscode/v0.1.0^{}"); got != head {
		t.Fatalf("confirmed local tag was removed: %s", got)
	}
}

func matchingRelease(metadata releaseMetadata) githubRelease {
	release := githubRelease{TagName: metadata.Tag, Name: metadata.Title, IsPrerelease: metadata.Prerelease}
	for _, name := range expectedReleaseAssetNames(metadata.Version) {
		release.Assets = append(release.Assets, struct {
			Name string `json:"name"`
		}{Name: name})
	}
	return release
}

func writeVSCodePackageManifest(t *testing.T, root, version string) {
	t.Helper()
	writeTestFile(t, filepath.Join(root, "extensions", "vscode", "package.json"), []byte("{\"name\":\"fql\",\"version\":\""+version+"\"}\n"), 0o644)
}

type releaseGitFixture struct {
	work   string
	remote string
}

func newReleaseGitFixture(t *testing.T) releaseGitFixture {
	t.Helper()
	root := t.TempDir()
	fixture := releaseGitFixture{work: filepath.Join(root, "work"), remote: filepath.Join(root, "origin.git")}
	if err := os.MkdirAll(fixture.work, 0o755); err != nil {
		t.Fatal(err)
	}
	runTestCommand(t, root, "git", "init", "--bare", fixture.remote)
	runTestCommand(t, fixture.work, "git", "init", "-b", "main")
	fixture.git(t, "config", "user.name", "Editorium Tests")
	fixture.git(t, "config", "user.email", "editorium@example.test")
	writeVSCodePackageManifest(t, fixture.work, "0.1.0")
	writeTestFile(t, filepath.Join(fixture.work, "ferretd.json"), []byte("{\"ferretd\":\"1.0.0-alpha.4\"}\n"), 0o644)
	fixture.git(t, "add", ".")
	fixture.git(t, "commit", "-m", "initial")
	fixture.git(t, "remote", "add", "origin", fixture.remote)
	fixture.git(t, "push", "-u", "origin", "main")
	return fixture
}

func (fixture releaseGitFixture) git(t *testing.T, args ...string) string {
	t.Helper()
	return runTestCommand(t, fixture.work, "git", args...)
}

func bareGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	return runTestCommand(t, directory, "git", args...)
}

func runTestCommand(t *testing.T, directory, name string, args ...string) string {
	t.Helper()
	command := exec.Command(name, args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func assertMissingGitRef(t *testing.T, root, ref string) {
	t.Helper()
	command := exec.Command("git", "show-ref", "--verify", "--quiet", ref)
	command.Dir = root
	if err := command.Run(); err == nil {
		t.Fatalf("ref exists: %s", ref)
	}
}

func assertMissingBareGitRef(t *testing.T, root, ref string) {
	t.Helper()
	assertMissingGitRef(t, root, ref)
}
