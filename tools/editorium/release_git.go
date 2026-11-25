package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"golang.org/x/mod/semver"
)

func fetchReleaseRefs(ctx context.Context, root, extension string) error {
	return runCommand(ctx, root, nil, "git", "fetch", "--no-tags", "--prune", releaseRemote,
		"+refs/heads/"+releaseBranch+":refs/release-remotes/"+releaseRemote+"/"+releaseBranch,
		"+refs/tags/"+extension+"/*:refs/release-remote-tags/"+extension+"/*")
}

func releaseRemoteSnapshot(ctx context.Context, root, extension string) (string, string, error) {
	refs, err := gitOutput(ctx, root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/release-remotes/"+releaseRemote+"/"+releaseBranch, "refs/release-remote-tags/"+extension+"/")
	if err != nil {
		return "", "", err
	}
	latest := ""
	prefix := "refs/release-remote-tags/" + extension + "/v"
	for line := range strings.Lines(refs) {
		ref, _, _ := strings.Cut(line, " ")
		if !strings.HasPrefix(ref, prefix) {
			continue
		}
		version := strings.TrimPrefix(ref, prefix)
		if fullReleaseVersion(version) && (latest == "" || semver.Compare("v"+version, "v"+latest) > 0) {
			latest = version
		}
	}
	return refs, latest, nil
}

func requireReleaseRemoteURL(ctx context.Context, root string) error {
	fetch, err := gitOutput(ctx, root, "remote", "get-url", "--all", releaseRemote)
	if err != nil {
		return err
	}
	push, err := gitOutput(ctx, root, "remote", "get-url", "--push", "--all", releaseRemote)
	if err != nil {
		return err
	}
	if fetch != push || strings.Contains(fetch, "\n") {
		return fmt.Errorf("release origin must have one identical fetch and push URL so remote publication can be verified")
	}
	return nil
}

func requireReleaseIndexFlags(ctx context.Context, root string) error {
	output, err := commandOutput(ctx, root, nil, "git", "ls-files", "-v", "-z")
	if err != nil {
		return err
	}
	for entry := range strings.SplitSeq(output, "\x00") {
		if entry != "" && entry[0] != 'H' {
			return fmt.Errorf("release requires ordinary tracked files without assume-unchanged or skip-worktree flags: %s", entry)
		}
	}
	return nil
}

func requireTrackedReleasePath(ctx context.Context, root, path string) error {
	if _, err := gitOutput(ctx, root, "ls-files", "--error-unmatch", path); err != nil {
		return fmt.Errorf("release manifest is not tracked: %s: %w", path, err)
	}
	tracked, err := gitOutput(ctx, root, "rev-parse", "HEAD:"+path)
	if err != nil {
		return err
	}
	working, err := gitOutput(ctx, root, "hash-object", "--path="+path, path)
	if err != nil {
		return err
	}
	if tracked != working {
		return fmt.Errorf("release manifest differs from the tracked HEAD version: %s", path)
	}
	return nil
}

func runReleaseGit(ctx context.Context, root string, args ...string) error {
	return runCommand(ctx, root, nil, "git", args...)
}

func createReleaseTagObject(ctx context.Context, root, tag, head string) (string, error) {
	ident, err := gitOutput(ctx, root, "var", "GIT_COMMITTER_IDENT")
	if err != nil {
		return "", err
	}
	command := exec.CommandContext(ctx, "git", "mktag")
	command.Dir = root
	command.Env = os.Environ()
	command.Stdin = strings.NewReader("object " + head + "\ntype commit\ntag " + tag + "\ntagger " + ident + "\n\nRelease " + tag + "\n")
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("create annotated release tag object: %s: %w", output, err)
	}
	return strings.TrimSpace(string(output)), nil
}
