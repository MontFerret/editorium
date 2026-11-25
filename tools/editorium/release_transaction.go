package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type releaseTransaction struct {
	root, extension, request                             string
	validate                                             func(context.Context, string, string) error
	gitRun                                               func(context.Context, string, ...string) error
	edits                                                []releaseManifestEdit
	start, head, snapshot, version, tag, tree, tagObject string
	origin                                               string
	blobs                                                map[string]string
	indexModes                                           map[string]string
	ownedCommit                                          string
	written                                              map[string]bool
	tagCreated                                           bool
	staged                                               bool
	retain                                               bool
}

func newReleaseTransaction(root, extension, request string, validate func(context.Context, string, string) error) *releaseTransaction {
	return &releaseTransaction{root: root, extension: extension, request: request, validate: validate, gitRun: runReleaseGit, written: make(map[string]bool), blobs: make(map[string]string), indexModes: make(map[string]string)}
}

func (t *releaseTransaction) execute(ctx context.Context) (result error) {
	checkOnly, err := envBool("RELEASE_CHECK_ONLY")
	if err != nil {
		return err
	}
	if err := t.prepare(ctx); err != nil {
		return err
	}
	defer func() {
		if (result != nil || checkOnly) && !t.retain {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			result = errors.Join(result, t.rollback(cleanup))
		}
	}()
	for _, edit := range t.edits {
		if bytes.Equal(edit.before, edit.after) {
			continue
		}
		// Recheck before each write; no broad restore is safe if another actor edits it.
		if err := t.checkManifest(edit, edit.before); err != nil {
			return err
		}
		if err := writeFileAtomic(filepath.Join(t.root, edit.path), edit.after, edit.mode); err != nil {
			return err
		}
		t.written[edit.path] = true
	}
	for _, edit := range t.edits {
		blob, err := gitOutput(ctx, t.root, "hash-object", "--path="+edit.path, edit.path)
		if err != nil {
			return err
		}
		t.blobs[edit.path] = blob
	}
	if err := t.validate(ctx, t.root, t.extension); err != nil {
		return err
	}
	if err := t.checkChanges(ctx); err != nil {
		return err
	}
	if err := t.checkRepository(ctx); err != nil {
		return err
	}
	if checkOnly {
		fmt.Printf("Check-only qualification passed for %s; restoring original manifests. No release refs were created or pushed.\n", t.tag)
		return nil
	}
	if err := t.commit(ctx); err != nil {
		return err
	}
	if err := t.checkRepository(ctx); err != nil {
		return err
	}
	if err := assertTagAvailable(ctx, t.root, t.tag); err != nil {
		return err
	}
	t.tagObject, err = createReleaseTagObject(ctx, t.root, t.tag, t.head)
	if err != nil {
		return err
	}
	if err := t.gitRun(ctx, t.root, "update-ref", "refs/tags/"+t.tag, t.tagObject, ""); err != nil {
		if object, inspectErr := gitOutput(context.WithoutCancel(ctx), t.root, "rev-parse", "--verify", "refs/tags/"+t.tag); inspectErr == nil && object == t.tagObject {
			t.retain = true
			return fmt.Errorf("tag creation returned an error but the intended tag exists; preserved local state for inspection: %w", err)
		}
		return err
	}
	t.tagCreated = true

	if err := t.checkRepository(ctx); err != nil {
		return err
	}
	if err := t.checkChanges(ctx); err != nil {
		return err
	}
	pushErr := t.gitRun(ctx, t.root, "push", "--atomic", "--no-follow-tags", releaseRemote,
		t.head+":refs/heads/"+releaseBranch, t.tagObject+":refs/tags/"+t.tag)
	if pushErr != nil {
		confirm, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := t.reconcilePush(confirm, pushErr); err != nil {
			return err
		}
	}
	fmt.Printf("Atomically pushed main and annotated tag %s at %s.\n", t.tag, t.head)
	return nil
}

func (t *releaseTransaction) prepare(ctx context.Context) error {
	if err := validateExtensions([]string{t.extension}); err != nil {
		return err
	}
	if err := requireReleaseRemoteURL(ctx, t.root); err != nil {
		return err
	}
	start, err := requireReleaseRepositoryState(ctx, t.root, t.extension)
	if err != nil {
		return err
	}
	t.start, t.head = start, start
	t.origin, err = gitOutput(ctx, t.root, "remote", "get-url", releaseRemote)
	if err != nil {
		return err
	}
	desc, err := describeRelease(t.extension)
	if err != nil {
		return err
	}
	current, err := desc.readVersion(t.root)
	if err != nil {
		return err
	}
	var latest string
	t.snapshot, latest, err = releaseRemoteSnapshot(ctx, t.root, t.extension)
	if err != nil {
		return err
	}
	t.version, err = resolveReleaseVersion(t.extension, t.request, current, latest)
	if err != nil {
		return err
	}
	t.tag = t.extension + "/v" + t.version
	if err := assertTagAvailable(ctx, t.root, t.tag); err != nil {
		return err
	}
	t.edits, err = desc.planManifests(t.root, current, t.version)
	if err != nil {
		return err
	}
	for _, edit := range t.edits {
		if err := requireTrackedReleasePath(ctx, t.root, edit.path); err != nil {
			return err
		}
		entry, err := gitOutput(ctx, t.root, "ls-files", "--stage", "--", edit.path)
		if err != nil {
			return err
		}
		fields := strings.Fields(entry)
		if len(fields) != 4 || fields[2] != "0" {
			return fmt.Errorf("release manifest index entry changed: %s", edit.path)
		}
		t.indexModes[edit.path] = fields[0]
	}
	if err := requireReleaseIndexFlags(ctx, t.root); err != nil {
		return err
	}
	// Fail before qualification if Git cannot create a release commit or annotation.
	if _, err := gitOutput(ctx, t.root, "var", "GIT_COMMITTER_IDENT"); err != nil {
		return err
	}
	if _, err := gitOutput(ctx, t.root, "var", "GIT_AUTHOR_IDENT"); err != nil {
		return err
	}
	fmt.Printf("Integration: %s\nCurrent:     %s\nLatest:      %s\nNext:        %s\nTag:         %s\nManifests:\n", t.extension, current, latest, t.version, t.tag)
	changed := false
	for _, edit := range t.edits {
		fmt.Printf("  %s\n", edit.path)
		changed = changed || !bytes.Equal(edit.before, edit.after)
	}
	fmt.Printf("Version commit required: %t\n", changed)
	return nil
}

func (t *releaseTransaction) checkManifest(edit releaseManifestEdit, expected []byte) error {
	info, err := os.Lstat(filepath.Join(t.root, edit.path))
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != edit.mode {
		return fmt.Errorf("release manifest type or mode changed: %s", edit.path)
	}
	data, err := os.ReadFile(filepath.Join(t.root, edit.path))
	if err != nil {
		return err
	}
	if !bytes.Equal(data, expected) {
		return fmt.Errorf("release manifest differs from the tracked HEAD or planned version: %s", edit.path)
	}
	return nil
}

func (t *releaseTransaction) checkChanges(ctx context.Context) error {
	allowed := make(map[string]bool)
	for _, edit := range t.edits {
		allowed[edit.path] = true
		if err := t.checkManifest(edit, edit.after); err != nil {
			return err
		}
	}
	if err := requireReleaseIndexFlags(ctx, t.root); err != nil {
		return err
	}
	output, err := commandOutput(ctx, t.root, nil, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return err
	}
	for entry := range strings.SplitSeq(output, "\x00") {
		if entry == "" {
			continue
		}
		if len(entry) < 4 || !allowed[entry[3:]] || strings.ContainsAny(entry[:2], "RCDATU?!") {
			return fmt.Errorf("release preparation changed an unexpected path or file state: %q", entry)
		}
	}
	if t.tree == "" {
		if _, err := gitOutput(ctx, t.root, "diff", "--cached", "--quiet"); err != nil {
			return fmt.Errorf("release validation staged unexpected changes: %w", err)
		}
	} else {
		for _, edit := range t.edits {
			entry, err := gitOutput(ctx, t.root, "ls-files", "--stage", "--", edit.path)
			if err != nil {
				return err
			}
			fields := strings.Fields(entry)
			if len(fields) < 3 || fields[0] != t.indexModes[edit.path] || fields[1] != t.blobs[edit.path] || fields[2] != "0" {
				return fmt.Errorf("release index manifest differs from qualified version: %s", edit.path)
			}
		}
		tree, err := gitOutput(ctx, t.root, "write-tree")
		if err != nil {
			return err
		}
		if tree != t.tree {
			return fmt.Errorf("release index changed after staging")
		}
	}
	return nil
}

func (t *releaseTransaction) checkRepository(ctx context.Context) error {
	branch, err := gitOutput(ctx, t.root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || branch != releaseBranch {
		return fmt.Errorf("release branch changed or HEAD became detached")
	}
	head, err := gitOutput(ctx, t.root, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head != t.head {
		return fmt.Errorf("release HEAD changed from %s to %s", t.head, head)
	}
	upstream, err := gitOutput(ctx, t.root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err != nil || upstream != releaseRemote+"/"+releaseBranch {
		return fmt.Errorf("release upstream changed")
	}
	if err := requireReleaseRemoteURL(ctx, t.root); err != nil {
		return err
	}
	origin, err := gitOutput(ctx, t.root, "remote", "get-url", releaseRemote)
	if err != nil || origin != t.origin {
		return fmt.Errorf("origin URL changed during release")
	}
	if err := fetchReleaseRefs(ctx, t.root, t.extension); err != nil {
		return err
	}
	snapshot, _, err := releaseRemoteSnapshot(ctx, t.root, t.extension)
	if err != nil {
		return err
	}
	if snapshot != t.snapshot {
		return fmt.Errorf("remote main or release tags changed during release; retry from a synchronized checkout")
	}
	if t.tagObject != "" {
		object, err := gitOutput(ctx, t.root, "rev-parse", "refs/tags/"+t.tag)
		if err != nil || object != t.tagObject {
			return fmt.Errorf("local release tag changed during release")
		}
	} else if err := assertTagAvailable(ctx, t.root, t.tag); err != nil {
		return err
	}
	return nil
}

func (t *releaseTransaction) commit(ctx context.Context) error {
	var paths []string
	for _, edit := range t.edits {
		if !bytes.Equal(edit.before, edit.after) {
			paths = append(paths, edit.path)
		}
	}
	if len(paths) == 0 {
		fmt.Println("Manifests already contain the planned version; no release commit needed.")
		return nil
	}
	if err := t.checkChanges(ctx); err != nil {
		return err
	}
	t.staged = true
	if err := t.gitRun(ctx, t.root, append([]string{"add", "--"}, paths...)...); err != nil {
		return err
	}
	var err error
	t.tree, err = gitOutput(ctx, t.root, "write-tree")
	if err != nil {
		return err
	}
	// Only version paths may differ from the admitted commit, including after git add hooks/filters.
	changed, err := gitOutput(ctx, t.root, "diff", "--cached", "--name-only", "-z", t.start)
	if err != nil {
		return err
	}
	for path := range strings.SplitSeq(changed, "\x00") {
		if path == "" {
			continue
		}
		found := false
		for _, expected := range paths {
			found = found || path == expected
		}
		if !found {
			return fmt.Errorf("unexpected staged release path: %s", path)
		}
	}
	if err := t.checkChanges(ctx); err != nil {
		return err
	}
	message := "chore(release): " + t.extension + " v" + t.version
	commitErr := t.gitRun(ctx, t.root, "commit", "-m", message)
	// Even a failing hook/transport wrapper may have completed the local commit.
	inspect, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	head, err := gitOutput(inspect, t.root, "rev-parse", "HEAD")
	if err != nil {
		t.retain = true
		return errors.Join(commitErr, err)
	}
	if head != t.start {
		identity, err := gitOutput(inspect, t.root, "show", "-s", "--format=%P%n%T%n%s", head)
		if err != nil || identity != t.start+"\n"+t.tree+"\n"+message {
			t.retain = true
			return errors.Join(commitErr, fmt.Errorf("release commit has unexpected parent, tree, or message; preserved local state for inspection at %s", head))
		}
		t.head, t.ownedCommit = head, head
	}
	if commitErr != nil {
		return commitErr
	}
	if t.ownedCommit == "" {
		return fmt.Errorf("release commit did not advance HEAD")
	}
	if err := t.checkChanges(ctx); err != nil {
		return err
	}
	for _, edit := range t.edits {
		if err := requireTrackedReleasePath(ctx, t.root, edit.path); err != nil {
			return err
		}
	}
	return nil
}

func (t *releaseTransaction) reconcilePush(ctx context.Context, pushErr error) error {
	origin, originErr := gitOutput(ctx, t.root, "remote", "get-url", releaseRemote)
	if originErr != nil || origin != t.origin {
		t.retain = true
		return errors.Join(pushErr, fmt.Errorf("origin URL changed; preserved local release state because publication cannot be confirmed"), originErr)
	}
	ref := "refs/tags/" + t.tag
	output, err := gitOutput(ctx, t.root, "ls-remote", releaseRemote, "refs/heads/"+releaseBranch, ref, ref+"^{}")
	refs := make(map[string]string)
	if err == nil {
		for line := range strings.Lines(output) {
			id, name, ok := strings.Cut(strings.TrimSpace(line), "\t")
			if !ok {
				err = fmt.Errorf("invalid remote ref response")
				break
			}
			refs[name] = id
		}
	}
	if err == nil && refs["refs/heads/"+releaseBranch] == t.head && refs[ref] == t.tagObject && refs[ref+"^{}"] == t.head {
		fmt.Println("Atomic push completed despite a local transport error; confirmed remote branch and annotated tag identity.")
		return nil
	}
	if err == nil && refs["refs/heads/"+releaseBranch] == t.start && refs[ref] == "" && refs[ref+"^{}"] == "" {
		return fmt.Errorf("atomic release push failed; rolling back owned local changes and tag: %w", pushErr)
	}
	t.retain = true
	return errors.Join(fmt.Errorf("atomic push outcome is uncertain or conflicting; preserved local release commit %s and tag %s (object %s). Inspect origin/main and both tag refs before recovery; do not retag or force-push: %w", t.head, t.tag, t.tagObject, pushErr), err)
}

func (t *releaseTransaction) rollback(ctx context.Context) error {
	var failures []error
	if t.tagCreated {
		if err := t.gitRun(ctx, t.root, "update-ref", "-d", "refs/tags/"+t.tag, t.tagObject); err != nil {
			failures = append(failures, fmt.Errorf("preserved changed local tag: %w", err))
		}
	}
	branch, err := gitOutput(ctx, t.root, "symbolic-ref", "--quiet", "--short", "HEAD")
	head, headErr := gitOutput(ctx, t.root, "rev-parse", "HEAD")
	if err != nil || headErr != nil || branch != releaseBranch || head != t.head {
		return errors.Join(append(failures, fmt.Errorf("release checkout changed; preserved local commit, index, and manifest state for recovery"))...)
	}
	if t.ownedCommit != "" {
		if err := t.gitRun(ctx, t.root, "update-ref", "-m", "rollback failed release", "refs/heads/"+releaseBranch, t.start, t.ownedCommit); err != nil {
			return errors.Join(append(failures, err)...)
		}
	}
	for _, edit := range t.edits {
		if t.staged && !bytes.Equal(edit.before, edit.after) {
			entry, indexErr := gitOutput(ctx, t.root, "ls-files", "--stage", "--", edit.path)
			fields := strings.Fields(entry)
			ordinary := indexErr == nil && len(fields) == 4 && fields[0] == t.indexModes[edit.path] && fields[2] == "0"
			if ordinary && fields[1] == t.blobs[edit.path] {
				if err := t.gitRun(ctx, t.root, "restore", "--source="+t.start, "--staged", "--", edit.path); err != nil {
					failures = append(failures, err)
				}
			} else {
				originalBlob, originalErr := gitOutput(ctx, t.root, "rev-parse", t.start+":"+edit.path)
				if !ordinary || originalErr != nil || fields[1] != originalBlob {
					failures = append(failures, fmt.Errorf("preserved changed index entry for %s; inspect it before retrying", edit.path))
				}
			}
		}
		if t.written[edit.path] {
			if err := t.checkManifest(edit, edit.after); err != nil {
				failures = append(failures, fmt.Errorf("preserved concurrent manifest edit: %w", err))
				continue
			}
			if err := writeFileAtomic(filepath.Join(t.root, edit.path), edit.before, edit.mode); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}
