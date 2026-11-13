package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
					return "", fmt.Errorf("GitHub lists %s but its published release is unavailable (draft=%t); inspect its original assets before recovery", m.Tag, release.Draft)
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
	return decideReleaseAction(&githubRelease{TagName: remote.Tag, Name: remote.Name, IsDraft: remote.Draft, IsPrerelease: remote.Prerelease, Assets: remote.Assets}, m)
}
