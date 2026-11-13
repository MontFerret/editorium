package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type githubReleaseResponse struct {
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
	} `json:"assets"`
}

func jetbrainsGitHubState(ctx context.Context, repositoryAPI, token string, m releaseMetadata) (string, error) {
	if token == "" {
		return "", fmt.Errorf("missing GH_TOKEN")
	}
	client := http.Client{Timeout: 30 * time.Second}
	get := func(endpoint string, result any) (int, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := client.Do(req)
		if err != nil {
			return 0, err
		}
		defer res.Body.Close()
		if res.StatusCode == http.StatusOK {
			if err := json.NewDecoder(res.Body).Decode(result); err != nil {
				return res.StatusCode, err
			}
		}
		return res.StatusCode, nil
	}
	var remote githubReleaseResponse
	status, err := get(repositoryAPI+"/releases/tags/"+url.PathEscape(m.Tag), &remote)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		// GitHub's by-tag endpoint can omit drafts. The publication token sees drafts in the list.
		for page := 1; ; page++ {
			var releases []githubReleaseResponse
			status, err = get(fmt.Sprintf("%s/releases?per_page=100&page=%d", repositoryAPI, page), &releases)
			if err != nil {
				return "", err
			}
			if status != http.StatusOK {
				return "", fmt.Errorf("cannot confirm GitHub release access (HTTP %d)", status)
			}
			if releases == nil {
				return "", fmt.Errorf("invalid GitHub release list")
			}
			for _, release := range releases {
				if release.Tag == "" {
					return "", fmt.Errorf("GitHub release list contains an entry without a tag")
				}
				if release.Tag == m.Tag {
					return "", fmt.Errorf("GitHub lists %s but its published release is unavailable (draft=%t); recover the original %s", m.Tag, release.Draft, strings.Join(m.Assets, " and "))
				}
			}
			if len(releases) < 100 {
				return "create", nil
			}
		}
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("cannot inspect GitHub release %s (HTTP %d)", m.Tag, status)
	}
	action, err := decideReleaseAction(&githubRelease{TagName: remote.Tag, Name: remote.Name, IsDraft: remote.Draft, IsPrerelease: remote.Prerelease, Assets: remote.Assets}, m)
	if err != nil {
		return "", fmt.Errorf("%w; recover the original %s", err, strings.Join(m.Assets, " and "))
	}
	return action, nil
}

func publishJetBrainsRelease(ctx context.Context, root, api, dir, digest string, m releaseMetadata) (bool, error) {
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	if _, err := validateReleaseAssets(dir, m.Assets); err != nil {
		return false, err
	}
	zip := filepath.Join(dir, m.Assets[0])
	sum, err := sha256File(zip)
	if err != nil {
		return false, err
	}
	checksum, err := os.ReadFile(zip + ".sha256")
	if err != nil {
		return false, err
	}
	if sum != digest || string(checksum) != sum+"  "+m.Assets[0]+"\n" {
		return false, fmt.Errorf("signed artifact or checksum differs from the signing job digest")
	}
	token := os.Getenv("GH_TOKEN")
	action, err := jetbrainsGitHubState(ctx, api, token, m)
	if err != nil {
		return false, err
	}
	if err := requireRemoteTag(ctx, root, m); err != nil {
		return false, err
	}
	if action == "noop" {
		return false, nil
	}
	args := []string{"release", "create", m.Tag, zip, zip + ".sha256", "--verify-tag", "--title", m.Title, "--generate-notes", "--latest=false"}
	if m.Prerelease {
		args = append(args, "--prerelease")
	}
	if _, err := commandOutput(ctx, root, nil, "gh", args...); err != nil {
		// A concurrent create or lost response can leave a complete release. Verify its original bytes downstream.
		state, inspectErr := jetbrainsGitHubState(ctx, api, token, m)
		if inspectErr != nil {
			return false, fmt.Errorf("%w; inspect publication: %w", err, inspectErr)
		}
		if state == "noop" {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
