package main

import (
	"testing"
)

func TestReleaseVersionResolution(t *testing.T) {
	for _, tc := range []struct{ current, latest, request, want string }{
		{"0.1.0", "0.1.0", "major", "1.0.0"},
		{"0.1.0", "0.1.0", "minor", "0.2.0"},
		{"0.1.0", "0.1.0", "patch", "0.1.1"},
		{"0.1.0", "", "patch", "0.1.1"},
		{"0.1.0", "", "0.1.0", "0.1.0"},
		{"0.1.0", "0.1.0", "2.0.0", "2.0.0"},
		{"0.1.0", "0.1.0", "0.2.0-rc.1", "0.2.0-rc.1"},
		{"0.1.1", "0.1.0", "patch", "0.1.1"},
		{"0.2.0", "0.1.0", "minor", "0.2.0"},
		{"0.2.0", "0.1.0", "0.2.0", "0.2.0"},
		{"1.0.0-rc.2", "1.0.0-rc.2", "major", "1.0.0"},
		{"1.2.0-rc.2", "1.2.0-rc.2", "minor", "1.2.0"},
		{"1.2.0-rc.2", "1.2.0-rc.2", "major", "2.0.0"},
		{"1.2.3-rc.2", "1.2.3-rc.2", "minor", "1.3.0"},
		{"1.2.3-rc.2", "1.2.3-rc.2", "major", "2.0.0"},
		{"0.2.0-rc.2", "0.2.0-rc.2", "patch", "0.2.0"},
		{"0.2.0-rc.2", "", "rc", "0.2.0-rc.3"},
		{"0.2.0-rc.10", "0.2.0-rc.9", "rc", "0.2.0-rc.10"},
		{"0.2.0-beta.1+build.4", "", "beta", "0.2.0-beta.2"},
		{"1.0.0+build.2", "1.0.0+build.1", "patch", "1.0.1"},
		{"18446744073709551615.0.0", "", "major", "18446744073709551616.0.0"},
	} {
		t.Run(tc.current+"/"+tc.latest+"/"+tc.request, func(t *testing.T) {
			got, err := resolveReleaseVersion("vscode", tc.request, tc.current, tc.latest)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %s", got, err, tc.want)
			}
		})
	}
	for _, tc := range []struct{ current, latest, request string }{
		{"0.1.0", "0.2.0", "patch"},
		{"0.1.0", "0.2.0", "1.0.0"},
		{"0.2.0", "0.1.0", "patch"},
		{"0.1.2", "0.1.0", "minor"},
		{"0.2.0", "0.1.0", "0.1.1"},
		{"0.1.0", "0.1.0", "0.1.0"},
		{"0.1.0", "0.1.0", "0.1.0+build.2"},
		{"0.1.0", "", "rc"},
		{"0.2.0-beta.1", "", "rc"},
		{"0.2.0-rc", "", "rc"},
		{"0.2.0-rc.1.extra", "", "rc"},
		{"0.1.0", "", "v0.2.0"},
		{"0.1.0", "", "0.2"},
		{"0.1.0", "", "0.2.0-rc.01"},
		{"0.1.0", "", "01.2.0"},
		{"0.1.0", "", ""},
	} {
		if got, err := resolveReleaseVersion("vscode", tc.request, tc.current, tc.latest); err == nil {
			t.Fatalf("accepted %#v as %s", tc, got)
		}
	}
}
