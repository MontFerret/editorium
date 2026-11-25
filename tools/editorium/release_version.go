package main

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"

	"golang.org/x/mod/semver"
)

func resolveReleaseVersion(extension, request, current, latest string) (string, error) {
	if !fullReleaseVersion(current) {
		return "", fmt.Errorf("invalid manifest version %q", current)
	}
	if latest != "" && semver.Compare("v"+current, "v"+latest) < 0 {
		return "", fmt.Errorf("cannot release %s: manifest version is behind the latest remote release\n\nLatest release:   %s\nManifest version: %s\n\nSynchronize the manifest with the latest release in a separate commit before attempting another release", extension, latest, current)
	}
	baseline := latest
	if baseline == "" {
		baseline = current
	}
	next := request
	explicit := fullReleaseVersion(request)
	if !explicit {
		var err error
		next, err = incrementReleaseVersion(baseline, request)
		if err != nil {
			return "", err
		}
		if semver.Compare("v"+current, "v"+baseline) > 0 && current != next {
			return "", fmt.Errorf("cannot release %s with %q\n\nLatest release:    %s\nManifest version:  %s\nRequested version: %s\n\nThe manifest already contains a conflicting advanced version. To release it explicitly:\n  make release %s %s", extension, request, latest, current, next, extension, current)
		}
	}
	if semver.Compare("v"+next, "v"+current) < 0 {
		return "", fmt.Errorf("release version %s would downgrade manifest version %s", next, current)
	}
	if latest != "" && semver.Compare("v"+next, "v"+latest) <= 0 {
		return "", fmt.Errorf("release version %s must have higher SemVer precedence than latest release %s", next, latest)
	}
	return next, nil
}

func incrementReleaseVersion(version, request string) (string, error) {
	core := strings.SplitN(strings.SplitN(version, "+", 2)[0], "-", 2)[0]
	parts := strings.Split(core, ".")
	pre := semver.Prerelease("v" + version)
	switch request {
	case "major":
		if pre != "" && parts[1] == "0" && parts[2] == "0" {
			return core, nil
		}
		return incrementReleaseNumber(parts[0]) + ".0.0", nil
	case "minor":
		if pre != "" && parts[2] == "0" {
			return core, nil
		}
		return parts[0] + "." + incrementReleaseNumber(parts[1]) + ".0", nil
	case "patch":
		if pre != "" {
			return core, nil
		}
		return parts[0] + "." + parts[1] + "." + incrementReleaseNumber(parts[2]), nil
	}
	if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*$`).MatchString(request) {
		return "", fmt.Errorf("invalid release request %q; expected canonical SemVer, major, minor, patch, or a prerelease identifier", request)
	}
	series := strings.Split(strings.TrimPrefix(pre, "-"), ".")
	if len(series) != 2 || series[0] != request || !regexp.MustCompile(`^(0|[1-9][0-9]*)$`).MatchString(series[1]) {
		return "", fmt.Errorf("baseline %s is not a matching %s prerelease series; use an explicit initial version such as %s-%s.1", version, request, core, request)
	}
	return core + "-" + request + "." + incrementReleaseNumber(series[1]), nil
}

func incrementReleaseNumber(value string) string {
	number, _ := new(big.Int).SetString(value, 10)
	return number.Add(number, big.NewInt(1)).String()
}
