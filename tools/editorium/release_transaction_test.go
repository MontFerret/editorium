package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseTransactionCommitsAndAtomicallyPushesBothIntegrations(t *testing.T) {
	for _, extension := range extensionNames() {
		t.Run(extension, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			base := f.git(t, "rev-parse", "HEAD")
			f.git(t, "tag", "-a", extension+"/v0.1.0", "-m", "initial release")
			f.git(t, "push", "origin", "refs/tags/"+extension+"/v0.1.0")
			f.git(t, "config", "push.followTags", "true")
			f.git(t, "tag", "-a", "unrelated/v9.0.0", "-m", "unrelated")
			qualified := false
			transaction := newReleaseTransaction(f.work, extension, "patch", func(_ context.Context, root, integration string) error {
				qualified = true
				desc, _ := describeRelease(integration)
				version, err := desc.readVersion(root)
				if err != nil || version != "0.1.1" {
					t.Fatalf("qualified version %s: %v", version, err)
				}
				return nil
			})
			pushed := false
			transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
				if args[0] == "push" {
					pushed = true
					if len(args) != 6 || args[1] != "--atomic" || args[2] != "--no-follow-tags" || args[3] != "origin" {
						t.Fatalf("non-atomic push: %v", args)
					}
				}
				return runReleaseGit(ctx, root, args...)
			}
			if err := transaction.execute(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !qualified || !pushed {
				t.Fatal("release skipped qualification or push")
			}
			head := f.git(t, "rev-parse", "HEAD")
			if head == base || f.git(t, "rev-parse", "HEAD^") != base {
				t.Fatal("missing release commit")
			}
			if f.git(t, "show", "-s", "--format=%s") != "chore(release): "+extension+" v0.1.1" {
				t.Fatal("wrong commit message")
			}
			if bareGit(t, f.remote, "rev-parse", "refs/heads/main") != head || bareGit(t, f.remote, "rev-parse", "refs/tags/"+extension+"/v0.1.1^{}") != head {
				t.Fatal("remote refs differ")
			}
			assertMissingBareGitRef(t, f.remote, "refs/tags/unrelated/v9.0.0")
			if status := f.git(t, "status", "--porcelain"); status != "" {
				t.Fatalf("dirty successful release: %s", status)
			}
			if extension == "jetbrains" {
				if _, err := metadataFromTag(f.work, "jetbrains/v0.1.1"); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestReleaseSelectsRemoteSemVerBaselineAndReusesPreparedVersion(t *testing.T) {
	f := newReleaseGitFixture(t)
	for _, tag := range []string{"vscode/v0.1.9", "vscode/v0.1.10-rc.10", "vscode/v0.1.10", "jetbrains/v99.0.0", "vscode/not-a-version"} {
		f.git(t, "tag", "-a", tag, "-m", tag)
		f.git(t, "push", "origin", "refs/tags/"+tag)
	}
	f.git(t, "tag", "vscode/v9.0.0") // Unpublished tags are not the released baseline.
	setReleaseFixtureVersion(t, f, "vscode", "0.2.0")
	head := f.git(t, "rev-parse", "HEAD")
	if err := runReleaseWithValidator(context.Background(), f.work, "vscode", "minor", releaseTestValidator); err != nil {
		t.Fatal(err)
	}
	if f.git(t, "rev-parse", "HEAD") != head {
		t.Fatal("created redundant version commit")
	}
}

func TestReleaseBehindManifestFailsBeforeAnyModification(t *testing.T) {
	for _, request := range []string{"patch", "1.0.0"} {
		f := newReleaseGitFixture(t)
		f.git(t, "tag", "vscode/v0.2.0")
		f.git(t, "push", "origin", "refs/tags/vscode/v0.2.0")
		err := runReleaseWithValidator(context.Background(), f.work, "vscode", request, func(context.Context, string, string) error { t.Fatal("qualified inconsistent manifest"); return nil })
		if err == nil || !strings.Contains(err.Error(), "behind") || !strings.Contains(err.Error(), "0.2.0") || !strings.Contains(err.Error(), "0.1.0") {
			t.Fatalf("error: %v", err)
		}
		if f.git(t, "status", "--porcelain") != "" {
			t.Fatal("modified inconsistent checkout")
		}
	}
}

func TestReleasePrereleaseSeriesAndPromotionRunCompleteTransactions(t *testing.T) {
	f := newReleaseGitFixture(t)
	qualified := 0
	for _, tc := range []struct{ request, version string }{{"0.2.0-rc.1", "0.2.0-rc.1"}, {"rc", "0.2.0-rc.2"}, {"patch", "0.2.0"}} {
		before := f.git(t, "rev-parse", "HEAD")
		err := runReleaseWithValidator(context.Background(), f.work, "jetbrains", tc.request, func(context.Context, string, string) error { qualified++; return nil })
		if err != nil {
			t.Fatal(err)
		}
		head := f.git(t, "rev-parse", "HEAD")
		if head == before || bareGit(t, f.remote, "rev-parse", "refs/heads/main") != head || bareGit(t, f.remote, "rev-parse", "refs/tags/jetbrains/v"+tc.version+"^{}") != head {
			t.Fatalf("incomplete %s transaction", tc.request)
		}
	}
	if qualified != 3 {
		t.Fatal("promotion skipped qualification")
	}
}

func TestReleaseRepairsOnlyLockfileWhenVersionAlreadyMatches(t *testing.T) {
	f := newReleaseGitFixture(t)
	path := filepath.Join(f.work, "extensions/vscode/package-lock.json")
	data, _ := os.ReadFile(path)
	writeTestFile(t, path, bytes.ReplaceAll(data, []byte("0.1.0"), []byte("0.0.9")), 0o644)
	f.git(t, "add", "extensions/vscode/package-lock.json")
	f.git(t, "commit", "-m", "stale lock versions")
	f.git(t, "push", "origin", "main")
	if err := runReleaseWithValidator(context.Background(), f.work, "vscode", "0.1.0", releaseTestValidator); err != nil {
		t.Fatal(err)
	}
	if paths := f.git(t, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"); paths != "extensions/vscode/package-lock.json" {
		t.Fatalf("changed %s", paths)
	}
	data, _ = os.ReadFile(path)
	if bytes.Contains(data, []byte("0.0.9")) {
		t.Fatal("lockfile was not synchronized")
	}
}

func TestReleaseRollsBackEveryOwnedStage(t *testing.T) {
	for _, stage := range []string{"validation", "add-before", "add-after", "commit-before", "commit-after", "tag", "push"} {
		t.Run(stage, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			base := f.git(t, "rev-parse", "HEAD")
			transaction := newReleaseTransaction(f.work, "vscode", "patch", func(context.Context, string, string) error {
				if stage == "validation" {
					return errors.New("injected validation")
				}
				return nil
			})
			transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
				match := (args[0] == "add" && strings.HasPrefix(stage, "add-")) || (args[0] == "commit" && strings.HasPrefix(stage, "commit-")) || (args[0] == "update-ref" && len(args) == 4 && stage == "tag") || (args[0] == "push" && stage == "push")
				if match {
					if strings.HasSuffix(stage, "after") {
						if err := runReleaseGit(ctx, root, args...); err != nil {
							return err
						}
					}
					return errors.New("injected " + stage)
				}
				return runReleaseGit(ctx, root, args...)
			}
			if err := transaction.execute(context.Background()); err == nil || !strings.Contains(err.Error(), "injected") {
				t.Fatalf("error %v", err)
			}
			if got := f.git(t, "rev-parse", "HEAD"); got != base {
				t.Fatalf("HEAD not restored: %s", got)
			}
			if status := f.git(t, "status", "--porcelain"); status != "" {
				t.Fatalf("rollback left changes: %s", status)
			}
			assertMissingGitRef(t, f.work, "refs/tags/vscode/v0.1.1")
			assertMissingBareGitRef(t, f.remote, "refs/tags/vscode/v0.1.1")
			if bareGit(t, f.remote, "rev-parse", "main") != base {
				t.Fatal("failure changed remote main")
			}
		})
	}
}

func TestReleasePreservesUnexpectedChangesAndConcurrentManifestEdit(t *testing.T) {
	for _, kind := range []string{"untracked", "staged", "manifest", "hidden"} {
		t.Run(kind, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			path := "surprise.txt"
			if kind == "manifest" || kind == "hidden" {
				path = "extensions/vscode/package.json"
			}
			err := runReleaseWithValidator(context.Background(), f.work, "vscode", "patch", func(context.Context, string, string) error {
				writeTestFile(t, filepath.Join(f.work, path), []byte("concurrent edit\n"), 0o644)
				if kind == "staged" {
					f.git(t, "add", path)
				}
				if kind == "hidden" {
					f.git(t, "update-index", "--assume-unchanged", path)
				}
				return nil
			})
			if err == nil {
				t.Fatal("accepted unexpected modification")
			}
			data, _ := os.ReadFile(filepath.Join(f.work, path))
			if string(data) != "concurrent edit\n" {
				t.Fatal("destroyed concurrent edit")
			}
			if kind == "staged" && f.git(t, "show", ":"+path) != "concurrent edit" {
				t.Fatal("destroyed unrelated index entry")
			}
			assertMissingBareGitRef(t, f.remote, "refs/tags/vscode/v0.1.1")
		})
	}
}

func TestReleaseDetectsConcurrentRemoteChanges(t *testing.T) {
	for _, kind := range []string{"main", "tag"} {
		f := newReleaseGitFixture(t)
		err := runReleaseWithValidator(context.Background(), f.work, "vscode", "patch", func(context.Context, string, string) error {
			if kind == "tag" {
				f.git(t, "tag", "vscode/v0.1.1")
				f.git(t, "push", "origin", "refs/tags/vscode/v0.1.1")
			} else {
				head := f.git(t, "rev-parse", "HEAD")
				tree := f.git(t, "rev-parse", "HEAD^{tree}")
				next := bareGit(t, f.remote, "-c", "user.name=Other", "-c", "user.email=other@example.test", "commit-tree", tree, "-p", head, "-m", "concurrent")
				bareGit(t, f.remote, "update-ref", "refs/heads/main", next)
			}
			return nil
		})
		if err == nil || !strings.Contains(err.Error(), "remote main or release tags changed") {
			t.Fatalf("concurrent %s: %v", kind, err)
		}
		if f.git(t, "status", "--porcelain") != "" {
			t.Fatal("did not restore transaction manifests")
		}
		if kind == "tag" && bareGit(t, f.remote, "rev-parse", "refs/tags/vscode/v0.1.1") == "" {
			t.Fatal("deleted concurrent remote tag")
		}
	}
}

func TestReleaseAtomicPushReconciliation(t *testing.T) {
	for _, outcome := range []string{"landed", "unavailable", "branch-only", "different-tag-object"} {
		t.Run(outcome, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			transaction := newReleaseTransaction(f.work, "vscode", "patch", releaseTestValidator)
			transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
				if args[0] != "push" {
					return runReleaseGit(ctx, root, args...)
				}
				switch outcome {
				case "landed":
					if err := runReleaseGit(ctx, root, args...); err != nil {
						return err
					}
				case "unavailable":
					if err := os.Rename(f.remote, f.remote+"-unavailable"); err != nil {
						t.Fatal(err)
					}
				case "branch-only":
					f.git(t, "push", "origin", transaction.head+":refs/heads/main")
				case "different-tag-object":
					f.git(t, "tag", "-a", "other", transaction.head, "-m", "different annotation")
					object := f.git(t, "rev-parse", "refs/tags/other")
					f.git(t, "push", "--atomic", "origin", transaction.head+":refs/heads/main", object+":refs/tags/"+transaction.tag)
				}
				return errors.New("transport failed after push")
			}
			err := transaction.execute(context.Background())
			if outcome == "landed" && err != nil {
				t.Fatal(err)
			}
			if outcome != "landed" && (err == nil || !strings.Contains(err.Error(), "preserved local")) {
				t.Fatalf("uncertain result: %v", err)
			}
			if f.git(t, "rev-parse", "HEAD") != transaction.head || f.git(t, "rev-parse", "refs/tags/"+transaction.tag) != transaction.tagObject {
				t.Fatal("removed local recovery state")
			}
		})
	}
}

func TestReleaseDryRunRestoresOriginalBytesAndDoesNotCreateRefs(t *testing.T) {
	for _, extension := range extensionNames() {
		for _, fail := range []bool{false, true} {
			f := newReleaseGitFixture(t)
			t.Setenv("RELEASE_CHECK_ONLY", "1")
			base := f.git(t, "rev-parse", "HEAD")
			called := false
			transaction := newReleaseTransaction(f.work, extension, "patch", func(context.Context, string, string) error {
				called = true
				if fail {
					return errors.New("qualification failed")
				}
				return nil
			})
			transaction.gitRun = func(context.Context, string, ...string) error {
				t.Fatal("dry run attempted a Git mutation")
				return nil
			}
			err := transaction.execute(context.Background())
			if (err != nil) != fail || !called {
				t.Fatalf("dry run qualification: %v", err)
			}
			if f.git(t, "status", "--porcelain") != "" || f.git(t, "rev-parse", "HEAD") != base {
				t.Fatal("dry run left manifest changes")
			}
			assertMissingGitRef(t, f.work, "refs/tags/"+extension+"/v0.1.1")
			assertMissingBareGitRef(t, f.remote, "refs/tags/"+extension+"/v0.1.1")
		}
	}
}

func TestReleaseCancellationRestoresManifests(t *testing.T) {
	f := newReleaseGitFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := runReleaseWithValidator(ctx, f.work, "vscode", "patch", func(context.Context, string, string) error { cancel(); return ctx.Err() })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if f.git(t, "status", "--porcelain") != "" {
		t.Fatal("cancellation left version changes")
	}
}

func TestReleaseAtomicServerRejectionDoesNotPublishEitherRef(t *testing.T) {
	for _, kind := range []string{"unsupported", "rejected"} {
		t.Run(kind, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			base := f.git(t, "rev-parse", "HEAD")
			if kind == "unsupported" {
				bareGit(t, f.remote, "config", "receive.advertiseAtomic", "false")
			} else {
				writeTestFile(t, filepath.Join(f.remote, "hooks/pre-receive"), []byte("#!/bin/sh\nexit 1\n"), 0o755)
			}
			if err := runReleaseWithValidator(context.Background(), f.work, "vscode", "patch", releaseTestValidator); err == nil {
				t.Fatal("accepted rejected push")
			}
			if f.git(t, "rev-parse", "HEAD") != base || bareGit(t, f.remote, "rev-parse", "refs/heads/main") != base {
				t.Fatal("failed atomic push advanced a branch")
			}
			if f.git(t, "status", "--porcelain") != "" {
				t.Fatal("failed atomic push left manifest edits")
			}
			assertMissingGitRef(t, f.work, "refs/tags/vscode/v0.1.1")
			assertMissingBareGitRef(t, f.remote, "refs/tags/vscode/v0.1.1")
		})
	}
}

func TestReleaseRollbackPreservesNewWorktreeAndIndexEdits(t *testing.T) {
	f := newReleaseGitFixture(t)
	base := f.git(t, "rev-parse", "HEAD")
	path := "extensions/vscode/package.json"
	transaction := newReleaseTransaction(f.work, "vscode", "patch", releaseTestValidator)
	transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
		if args[0] == "commit" {
			writeTestFile(t, filepath.Join(root, path), []byte("concurrent manifest\n"), 0o644)
			writeTestFile(t, filepath.Join(root, "extra.txt"), []byte("concurrent staged file\n"), 0o644)
			f.git(t, "add", "extra.txt")
			return errors.New("commit failed")
		}
		return runReleaseGit(ctx, root, args...)
	}
	if err := transaction.execute(context.Background()); err == nil {
		t.Fatal("accepted commit failure")
	}
	if f.git(t, "rev-parse", "HEAD") != base {
		t.Fatal("changed HEAD")
	}
	if f.git(t, "show", ":extra.txt") != "concurrent staged file" {
		t.Fatal("destroyed unrelated staged change")
	}
	if f.git(t, "rev-parse", ":"+path) != f.git(t, "rev-parse", "HEAD:"+path) {
		t.Fatal("did not remove owned manifest staging")
	}
	data, _ := os.ReadFile(filepath.Join(f.work, path))
	if string(data) != "concurrent manifest\n" {
		t.Fatal("destroyed concurrent manifest change")
	}
}

func TestReleaseRollbackPreservesConcurrentIndexMode(t *testing.T) {
	f := newReleaseGitFixture(t)
	path := "extensions/vscode/package.json"
	transaction := newReleaseTransaction(f.work, "vscode", "patch", releaseTestValidator)
	transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
		if args[0] == "commit" {
			f.git(t, "update-index", "--chmod=+x", path)
			return errors.New("commit failed")
		}
		return runReleaseGit(ctx, root, args...)
	}
	err := transaction.execute(context.Background())
	if err == nil || !strings.Contains(err.Error(), "preserved changed index entry") {
		t.Fatalf("mode race: %v", err)
	}
	if !strings.HasPrefix(f.git(t, "ls-files", "--stage", "--", path), "100755 ") {
		t.Fatal("destroyed concurrent staged mode change")
	}
}

func TestReleaseRefRacesPreserveUnownedState(t *testing.T) {
	for _, kind := range []string{"head", "tag"} {
		t.Run(kind, func(t *testing.T) {
			f := newReleaseGitFixture(t)
			base := f.git(t, "rev-parse", "HEAD")
			transaction := newReleaseTransaction(f.work, "vscode", "patch", releaseTestValidator)
			var other string
			transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
				if args[0] == "update-ref" && len(args) == 4 {
					if kind == "head" {
						f.git(t, "commit", "--allow-empty", "-m", "concurrent commit")
						other = f.git(t, "rev-parse", "HEAD")
					} else {
						f.git(t, "tag", "-a", transaction.tag, base, "-m", "concurrent tag")
						other = f.git(t, "rev-parse", "refs/tags/"+transaction.tag)
					}
					return errors.New("injected tag failure")
				}
				return runReleaseGit(ctx, root, args...)
			}
			if err := transaction.execute(context.Background()); err == nil {
				t.Fatal("accepted raced release")
			}
			if kind == "head" && f.git(t, "rev-parse", "HEAD") != other {
				t.Fatal("destroyed concurrent commit")
			}
			if kind == "tag" && f.git(t, "rev-parse", "refs/tags/"+transaction.tag) != other {
				t.Fatal("destroyed concurrent tag")
			}
			assertMissingBareGitRef(t, f.remote, "refs/tags/vscode/v0.1.1")
		})
	}
}

func TestReleaseRejectsUnexpectedCommitHookContent(t *testing.T) {
	f := newReleaseGitFixture(t)
	transaction := newReleaseTransaction(f.work, "vscode", "patch", releaseTestValidator)
	transaction.gitRun = func(ctx context.Context, root string, args ...string) error {
		if args[0] == "commit" {
			writeTestFile(t, filepath.Join(root, "hook-change.txt"), []byte("unqualified\n"), 0o644)
			f.git(t, "add", "hook-change.txt")
		}
		return runReleaseGit(ctx, root, args...)
	}
	err := transaction.execute(context.Background())
	if err == nil || !strings.Contains(err.Error(), "unexpected parent, tree, or message") {
		t.Fatalf("hook result: %v", err)
	}
	if f.git(t, "show", "HEAD:hook-change.txt") != "unqualified" {
		t.Fatal("destroyed unqualified commit instead of preserving recovery state")
	}
	assertMissingBareGitRef(t, f.remote, "refs/tags/vscode/v0.1.1")
}

func TestReleasePreflightRejectsDifferentPushDestinationAndUpstream(t *testing.T) {
	for _, kind := range []string{"push-url", "upstream", "hidden-lockfile", "untracked-lockfile"} {
		f := newReleaseGitFixture(t)
		switch kind {
		case "push-url":
			f.git(t, "remote", "set-url", "--push", "origin", f.remote+"-other")
		case "upstream":
			f.git(t, "branch", "--unset-upstream")
		case "hidden-lockfile":
			f.git(t, "update-index", "--assume-unchanged", "extensions/vscode/package-lock.json")
			writeTestFile(t, filepath.Join(f.work, "extensions/vscode/package-lock.json"), []byte(`{"version":"0.1.0","packages":{"":{"version":"0.1.0"}},"other":true}`), 0o644)
		case "untracked-lockfile":
			f.git(t, "rm", "--cached", "extensions/vscode/package-lock.json")
			f.git(t, "commit", "-m", "untrack lockfile")
			f.git(t, "push", "origin", "main")
		}
		if err := runReleaseWithValidator(context.Background(), f.work, "vscode", "patch", func(context.Context, string, string) error { t.Fatal("qualified invalid repository"); return nil }); err == nil {
			t.Fatalf("accepted %s", kind)
		}
	}
}

func releaseTestValidator(context.Context, string, string) error { return nil }

func setReleaseFixtureVersion(t *testing.T, f releaseGitFixture, extension, version string) {
	t.Helper()
	desc, _ := describeRelease(extension)
	current, err := desc.readVersion(f.work)
	if err != nil {
		t.Fatal(err)
	}
	edits, err := desc.planManifests(f.work, current, version)
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range edits {
		writeTestFile(t, filepath.Join(f.work, edit.path), edit.after, edit.mode)
	}
	f.git(t, "add", ".")
	f.git(t, "commit", "-m", "prepare version")
	f.git(t, "push", "origin", "main")
}
