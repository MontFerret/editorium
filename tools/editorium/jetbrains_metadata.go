package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const jetbrainsVersionSource = "extensions/jetbrains/gradle.properties"
const jetbrainsPluginID = "org.ferretlang.jetbrains"

func jetbrainsProperty(root, key string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, jetbrainsVersionSource))
	if err != nil {
		return "", err
	}
	var found []string
	for line := range strings.SplitSeq(string(data), "\n") {
		name, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && strings.TrimSpace(name) == key {
			found = append(found, strings.TrimSpace(value))
		}
	}
	if len(found) != 1 || found[0] == "" {
		return "", fmt.Errorf("%s must declare exactly one %s", jetbrainsVersionSource, key)
	}
	return found[0], nil
}

func jetbrainsPluginVersion(root string) (string, error) {
	v, err := jetbrainsProperty(root, "pluginVersion")
	if err != nil {
		return "", err
	}
	if !fullReleaseVersion(v) {
		return "", fmt.Errorf("invalid pluginVersion %q in %s", v, jetbrainsVersionSource)
	}
	return v, nil
}

func jetbrainsReleaseAssetNames(version string) []string {
	zip := jetbrainsArchiveRoot + "-" + version + "-signed.zip"
	return []string{zip, zip + ".sha256"}
}
