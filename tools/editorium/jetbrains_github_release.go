package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type githubReleaseResponse struct {
	ID         int64  `json:"id"`
	Tag        string `json:"tag_name"`
	Name       string `json:"name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	} `json:"assets"`
}

func jetbrainsGitHubReleaseJSON(ctx context.Context, method, endpoint, token string, body io.Reader, result any) (int, error) {
	if token == "" {
		return 0, fmt.Errorf("missing GH_TOKEN")
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK {
		return res.StatusCode, json.NewDecoder(res.Body).Decode(result)
	}
	return res.StatusCode, nil
}

func readJetBrainsGitHubReleaseByTag(ctx context.Context, repositoryAPI, token, tag string) (githubReleaseResponse, int, error) {
	var remote githubReleaseResponse
	status, err := jetbrainsGitHubReleaseJSON(ctx, http.MethodGet, repositoryAPI+"/releases/tags/"+url.PathEscape(tag), token, nil, &remote)
	return remote, status, err
}

func jetbrainsGitHubState(ctx context.Context, repositoryAPI, token string, m releaseMetadata) (string, error) {
	remote, status, err := readJetBrainsGitHubReleaseByTag(ctx, repositoryAPI, token, m.Tag)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		// GitHub's by-tag endpoint can omit drafts. The publication token sees drafts in the list.
		for page := 1; ; page++ {
			var releases []githubReleaseResponse
			status, err = jetbrainsGitHubReleaseJSON(ctx, http.MethodGet, fmt.Sprintf("%s/releases?per_page=100&page=%d", repositoryAPI, page), token, nil, &releases)
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
	return validateJetBrainsGitHubRelease(remote, m)
}

func validateJetBrainsGitHubRelease(remote githubReleaseResponse, m releaseMetadata) (string, error) {
	published := githubRelease{TagName: remote.Tag, Name: remote.Name, IsDraft: remote.Draft, IsPrerelease: remote.Prerelease}
	for _, asset := range remote.Assets {
		published.Assets = append(published.Assets, struct {
			Name string `json:"name"`
		}{Name: asset.Name})
	}
	action, err := decideReleaseAction(&published, m)
	if err != nil {
		return "", fmt.Errorf("%w; recover the original %s", err, strings.Join(m.Assets, " and "))
	}
	return action, nil
}

func requireJetBrainsPublishedRelease(ctx context.Context, api, token string, m releaseMetadata) (githubReleaseResponse, error) {
	remote, status, err := readJetBrainsGitHubReleaseByTag(ctx, api, token, m.Tag)
	if err != nil {
		return githubReleaseResponse{}, err
	}
	if status != http.StatusOK {
		return githubReleaseResponse{}, fmt.Errorf("cannot verify published GitHub Release for %s (HTTP %d)", m.Tag, status)
	}
	if _, err := validateJetBrainsGitHubRelease(remote, m); err != nil {
		return githubReleaseResponse{}, err
	}
	return remote, nil
}

func requireJetBrainsReleaseAbsent(ctx context.Context, api, token string, m releaseMetadata) error {
	action, err := jetbrainsGitHubState(ctx, api, token, m)
	if err != nil {
		return err
	}
	if action != "create" {
		return fmt.Errorf("GitHub Release %s already exists. Re-run all jobs to verify the original signed assets", m.Tag)
	}
	return nil
}

func jetbrainsPublishedAssetIDs(ctx context.Context, api, token string, m releaseMetadata) ([2]int64, error) {
	remote, err := requireJetBrainsPublishedRelease(ctx, api, token, m)
	if err != nil {
		return [2]int64{}, err
	}
	ids := make(map[string]int64, len(remote.Assets))
	for _, asset := range remote.Assets {
		ids[asset.Name] = asset.ID
	}
	zipID, checksumID := ids[m.Assets[0]], ids[m.Assets[1]]
	if zipID <= 0 || checksumID <= 0 || zipID == checksumID {
		return [2]int64{}, fmt.Errorf("published GitHub Release for %s has invalid asset IDs", m.Tag)
	}
	return [2]int64{zipID, checksumID}, nil
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
	if err := createAndPublishJetBrainsDraft(ctx, root, api, token, zip, m); err != nil {
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

func createAndPublishJetBrainsDraft(ctx context.Context, root, api, token, zip string, m releaseMetadata) error {
	// Separate draft creation from publication so a lost PATCH response cannot trigger gh's draft cleanup.
	args := []string{"release", "create", m.Tag, zip, zip + ".sha256", "--draft", "--verify-tag", "--title", m.Title, "--generate-notes", "--latest=false"}
	if m.Prerelease {
		args = append(args, "--prerelease")
	}
	draftURL, err := commandOutput(ctx, root, nil, "gh", args...)
	if err != nil {
		return err
	}
	view, err := commandOutput(ctx, root, nil, "gh", "release", "view", m.Tag, "--json", "databaseId,url,isDraft,tagName,name,isPrerelease,assets")
	if err != nil {
		return err
	}
	var draft struct {
		githubRelease
		ID  int64  `json:"databaseId"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(view), &draft); err != nil {
		return fmt.Errorf("read GitHub release draft: %w", err)
	}
	if draft.ID <= 0 || draft.URL == "" || draft.URL != strings.TrimSpace(draftURL) || !draft.IsDraft {
		return fmt.Errorf("cannot identify the newly created draft for %s", m.Tag)
	}
	candidate := draft.githubRelease
	candidate.IsDraft = false
	if _, err := decideReleaseAction(&candidate, m); err != nil {
		return err
	}
	current, status, err := readJetBrainsGitHubReleaseByTag(ctx, api, token, m.Tag)
	if err != nil {
		return err
	}
	if status != http.StatusNotFound && !(status == http.StatusOK && current.Draft && current.ID == draft.ID) {
		return fmt.Errorf("cannot confirm the new draft is still unpublished for %s (HTTP %d)", m.Tag, status)
	}
	if err := requireRemoteTag(ctx, root, m); err != nil {
		return err
	}

	var published githubReleaseResponse
	status, err = jetbrainsGitHubReleaseJSON(ctx, http.MethodPatch, fmt.Sprintf("%s/releases/%d", api, draft.ID), token,
		strings.NewReader(`{"draft":false,"make_latest":"false"}`), &published)
	if err != nil {
		return fmt.Errorf("publish GitHub Release draft %d: %w", draft.ID, err)
	}
	if status != http.StatusOK || published.ID != draft.ID {
		return fmt.Errorf("GitHub did not confirm publication of draft %d (HTTP %d)", draft.ID, status)
	}
	_, err = validateJetBrainsGitHubRelease(published, m)
	return err
}
