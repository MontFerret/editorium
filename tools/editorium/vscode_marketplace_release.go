package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type vscodeMarketplaceAsset struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	State  string `json:"state"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}

type vscodeMarketplaceRelease struct {
	Tag        string                   `json:"tag_name"`
	Name       string                   `json:"name"`
	Draft      bool                     `json:"draft"`
	Prerelease bool                     `json:"prerelease"`
	Assets     []vscodeMarketplaceAsset `json:"assets"`
}

func verifyVSCodeMarketplaceAssets(root, tag, directory string, download bool) error {
	if directory == "" {
		return fmt.Errorf("missing required release option: --directory")
	}
	if !filepath.IsAbs(directory) {
		directory = filepath.Join(root, directory)
	}
	repository, token := os.Getenv("GITHUB_REPOSITORY"), os.Getenv("GH_TOKEN")
	if repository == "" || token == "" {
		return fmt.Errorf("Marketplace release verification requires GITHUB_REPOSITORY and GH_TOKEN")
	}
	api := "https://api.github.com/repos/" + repository + "/releases"
	client := &http.Client{Timeout: 2 * time.Minute}
	if err := prepareVSCodeMarketplaceAssets(context.Background(), root, api, token, tag, directory, download, client); err != nil {
		return err
	}
	fmt.Printf("Verified all six Marketplace packages for %s against the GitHub Release.\n", tag)
	return nil
}

func prepareVSCodeMarketplaceAssets(ctx context.Context, root, api, token, tag, directory string, download bool, client *http.Client) error {
	metadata, manifest, err := resolveVSCodeMarketplaceRelease(ctx, root, tag, download)
	if err != nil {
		return err
	}
	assets, err := readVSCodeMarketplaceRelease(ctx, api, token, metadata, client)
	if err != nil {
		return err
	}

	verified := false
	if download {
		if err := os.Mkdir(directory, 0o700); err != nil {
			return fmt.Errorf("create recovery directory %s: %w", directory, err)
		}
		defer func() {
			if !verified {
				_ = os.RemoveAll(directory)
			}
		}()
		for _, name := range metadata.Assets {
			if err := downloadVSCodeMarketplaceAsset(ctx, api, token, directory, assets[name], client); err != nil {
				return fmt.Errorf("download release asset %s: %w", name, err)
			}
		}
	}

	if _, err := validateReleaseAssets(directory, metadata.Assets); err != nil {
		return err
	}
	for _, target := range vscodeTargets {
		name := vsixFilename(metadata.Version, target)
		if err := verifyVSCodeMarketplacePackage(filepath.Join(directory, name), target, manifest, assets[name]); err != nil {
			return fmt.Errorf("verify %s: %w", name, err)
		}
	}
	if err := requireRemoteTag(ctx, root, metadata); err != nil {
		return err
	}
	verified = true
	return nil
}

func resolveVSCodeMarketplaceRelease(ctx context.Context, root, tag string, download bool) (releaseMetadata, vscodeManifest, error) {
	version, ok := strings.CutPrefix(tag, "vscode/v")
	if !ok || !marketplaceVersionEligible(version) {
		return releaseMetadata{}, vscodeManifest{}, fmt.Errorf("Marketplace requires an exact stable VS Code release tag, got %q", tag)
	}
	description, err := describeRelease("vscode")
	if err != nil {
		return releaseMetadata{}, vscodeManifest{}, err
	}
	metadata := releaseMetadataForVersion(description, "vscode", version)
	remote, err := remoteTag(ctx, root, tag)
	if err != nil {
		return releaseMetadata{}, vscodeManifest{}, err
	}
	if remote.object == "" || remote.commit == "" {
		return releaseMetadata{}, vscodeManifest{}, fmt.Errorf("missing remote annotated tag %s", tag)
	}
	metadata.TagObject, metadata.Commit = remote.object, remote.commit
	if download {
		// Fetch the tag into FETCH_HEAD and keep the trusted workflow checkout.
		if _, err := gitOutput(ctx, root, "fetch", "--no-tags", "--depth=1", releaseRemote, "refs/tags/"+tag); err != nil {
			return releaseMetadata{}, vscodeManifest{}, err
		}
		object, err := gitOutput(ctx, root, "rev-parse", "FETCH_HEAD")
		if err != nil {
			return releaseMetadata{}, vscodeManifest{}, err
		}
		if object != metadata.TagObject {
			return releaseMetadata{}, vscodeManifest{}, fmt.Errorf("remote annotated tag %s changed during fetch", tag)
		}
	} else {
		head, err := gitOutput(ctx, root, "rev-parse", "HEAD")
		if err != nil {
			return releaseMetadata{}, vscodeManifest{}, err
		}
		if head != metadata.Commit {
			return releaseMetadata{}, vscodeManifest{}, fmt.Errorf("tag %s points to %s, checkout is %s", tag, metadata.Commit, head)
		}
	}
	manifestSource := metadata.Commit + "^{commit}:" + description.versionSource
	contents, err := gitOutput(ctx, root, "show", manifestSource)
	if err != nil {
		return releaseMetadata{}, vscodeManifest{}, err
	}
	manifest, err := parseVSCodeManifest([]byte(contents), manifestSource)
	if err != nil {
		return releaseMetadata{}, vscodeManifest{}, err
	}
	if manifest.Version != version {
		return releaseMetadata{}, vscodeManifest{}, fmt.Errorf("tag %s conflicts with its VS Code manifest version %s", tag, manifest.Version)
	}
	return metadata, manifest, nil
}

func readVSCodeMarketplaceRelease(ctx context.Context, api, token string, metadata releaseMetadata, client *http.Client) (map[string]vscodeMarketplaceAsset, error) {
	response, err := getVSCodeMarketplaceReleaseResource(ctx, api+"/tags/"+url.PathEscape(metadata.Tag), token, "application/vnd.github+json", client)
	if err != nil {
		return nil, fmt.Errorf("read published GitHub Release for %s: %w", metadata.Tag, err)
	}
	defer response.Body.Close()
	var release vscodeMarketplaceRelease
	if err := json.NewDecoder(response.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode GitHub Release for %s: %w", metadata.Tag, err)
	}
	published := githubRelease{TagName: release.Tag, Name: release.Name, IsDraft: release.Draft, IsPrerelease: release.Prerelease}
	for _, asset := range release.Assets {
		published.Assets = append(published.Assets, struct {
			Name string `json:"name"`
		}{Name: asset.Name})
	}
	action, err := decideReleaseAction(&published, metadata)
	if err != nil {
		return nil, err
	}
	if action != "noop" {
		return nil, fmt.Errorf("GitHub Release for %s must already be published", metadata.Tag)
	}
	assets := make(map[string]vscodeMarketplaceAsset, len(release.Assets))
	for _, asset := range release.Assets {
		checksum, hasSHA256 := strings.CutPrefix(asset.Digest, "sha256:")
		digest, err := hex.DecodeString(checksum)
		if asset.ID <= 0 || asset.State != "uploaded" || asset.Size <= 0 || !hasSHA256 || err != nil || len(digest) != sha256.Size {
			return nil, fmt.Errorf("release asset %s must be uploaded with a positive size and a SHA-256 digest", asset.Name)
		}
		assets[asset.Name] = asset
	}
	return assets, nil
}

func getVSCodeMarketplaceReleaseResource(ctx context.Context, endpoint, token, accept string, client *http.Client) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", accept)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	return response, nil
}

func downloadVSCodeMarketplaceAsset(ctx context.Context, api, token, directory string, asset vscodeMarketplaceAsset, client *http.Client) error {
	response, err := getVSCodeMarketplaceReleaseResource(ctx, fmt.Sprintf("%s/assets/%d", api, asset.ID), token, "application/octet-stream", client)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	file, err := os.OpenFile(filepath.Join(directory, asset.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	return errors.Join(copyLimited(file, response.Body, asset.Size, asset.Name), file.Close())
}

func verifyVSCodeMarketplacePackage(path string, target vscodeTarget, manifest vscodeManifest, asset vscodeMarketplaceAsset) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() != asset.Size {
		return fmt.Errorf("file size does not match the GitHub Release")
	}
	digest, err := sha256File(path)
	if err != nil {
		return err
	}
	if "sha256:"+digest != asset.Digest {
		return fmt.Errorf("SHA-256 digest does not match the GitHub Release")
	}
	releaseTarget, err := ferretdTargetForVSCode(target)
	if err != nil {
		return err
	}
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	_, err = inspectVSIX(&archive.Reader, target, releaseTarget, manifest, true)
	return err
}
