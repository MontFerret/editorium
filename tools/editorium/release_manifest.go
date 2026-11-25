package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type releaseManifestEdit struct {
	path          string
	before, after []byte
	mode          os.FileMode
}

type releaseJSONEdit struct {
	start, end int
	value      []byte
}

func planVSCodeReleaseManifests(root, current, next string) ([]releaseManifestEdit, error) {
	var edits []releaseManifestEdit
	for _, path := range []string{"extensions/vscode/package.json", "extensions/vscode/package-lock.json"} {
		edit, err := readReleaseManifest(root, path)
		if err != nil {
			return nil, err
		}
		fields := map[string]string{"/version": next}
		if strings.HasSuffix(path, "package-lock.json") {
			fields["/packages//version"] = next
		}
		updated, old, err := replaceReleaseJSONVersions(edit.before, fields)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		var keys []string
		for field := range old {
			keys = append(keys, field)
		}
		sort.Strings(keys)
		for _, field := range keys {
			value := old[field]
			if strings.HasSuffix(path, "package-lock.json") && value != current {
				fmt.Fprintf(os.Stderr, "Warning: %s %q version %s differs from package.json %s; synchronizing to %s.\n", path, field, value, current, next)
			}
		}
		edit.after = updated
		edits = append(edits, edit)
	}
	return edits, nil
}

func planJetBrainsReleaseManifests(root, _, next string) ([]releaseManifestEdit, error) {
	edit, err := readReleaseManifest(root, jetbrainsVersionSource)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(edit.before), "\n")
	count := 0
	for i, line := range lines {
		name, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(name) != "pluginVersion" {
			continue
		}
		count++
		leading := len(value) - len(strings.TrimLeft(value, " \t"))
		trailing := len(strings.TrimRight(value, " \t\r"))
		if trailing < leading {
			return nil, fmt.Errorf("empty pluginVersion")
		}
		lines[i] = name + "=" + value[:leading] + next + value[trailing:]
	}
	if count != 1 {
		return nil, fmt.Errorf("%s must declare exactly one pluginVersion", edit.path)
	}
	edit.after = []byte(strings.Join(lines, "\n"))
	return []releaseManifestEdit{edit}, nil
}

func readReleaseManifest(root, path string) (releaseManifestEdit, error) {
	info, err := os.Lstat(filepath.Join(root, path))
	if err != nil {
		return releaseManifestEdit{}, err
	}
	if !info.Mode().IsRegular() {
		return releaseManifestEdit{}, fmt.Errorf("release manifest must be a regular file: %s", path)
	}
	data, err := os.ReadFile(filepath.Join(root, path))
	return releaseManifestEdit{path: path, before: data, mode: info.Mode().Perm()}, err
}

// Replace string values by their JSON paths, retaining every unrelated byte.
func replaceReleaseJSONVersions(data []byte, fields map[string]string) ([]byte, map[string]string, error) {
	if !json.Valid(data) {
		return nil, nil, fmt.Errorf("invalid JSON")
	}
	var edits []releaseJSONEdit
	old := make(map[string]string)
	var visit func([]byte, []string, int) error
	visit = func(input []byte, path []string, base int) error {
		decoder := json.NewDecoder(bytes.NewReader(input))
		token, err := decoder.Token()
		if err != nil || token != json.Delim('{') {
			return fmt.Errorf("expected JSON object at %q", strings.Join(path, "."))
		}
		seen := make(map[string]bool)
		for decoder.More() {
			token, err = decoder.Token()
			if err != nil {
				return err
			}
			key := token.(string)
			if seen[key] {
				return fmt.Errorf("duplicate JSON field %q", key)
			}
			seen[key] = true
			var raw json.RawMessage
			if err := decoder.Decode(&raw); err != nil {
				return err
			}
			start := base + int(decoder.InputOffset()) - len(raw)
			child := append(append([]string(nil), path...), key)
			escaped := make([]string, len(child))
			for i, segment := range child {
				escaped[i] = strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
			}
			field := "/" + strings.Join(escaped, "/")
			if value, ok := fields[field]; ok {
				var previous string
				if err := json.Unmarshal(raw, &previous); err != nil || previous == "" {
					return fmt.Errorf("version field %q must be a nonempty string", field)
				}
				old[field] = previous
				encoded, _ := json.Marshal(value)
				edits = append(edits, releaseJSONEdit{start, start + len(raw), encoded})
			}
			for target := range fields {
				if strings.HasPrefix(target, field+"/") {
					if err := visit(raw, child, start); err != nil {
						return err
					}
					break
				}
			}
		}
		return nil
	}
	if err := visit(data, nil, 0); err != nil {
		return nil, nil, err
	}
	if len(old) != len(fields) {
		return nil, nil, fmt.Errorf("missing required root version field")
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	result := bytes.Clone(data)
	for _, edit := range edits {
		result = append(append(append([]byte(nil), result[:edit.start]...), edit.value...), result[edit.end:]...)
	}
	return result, old, nil
}
