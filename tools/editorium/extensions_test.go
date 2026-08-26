package main

import (
	"strings"
	"testing"
)

func TestExtensionCatalogSelectionAndUnknownIntegrations(t *testing.T) {
	names := extensionNames()
	if strings.Join(names, ",") != "jetbrains,vscode" {
		t.Fatalf("extensionNames() = %v", names)
	}
	if err := validateExtensions(nil); err != nil {
		t.Fatal(err)
	}
	if err := validateExtensions([]string{"jetbrains", "vscode"}); err != nil {
		t.Fatal(err)
	}
	for _, names := range [][]string{{"unknown"}, {"vscode", "vscode"}, {"jetbrains", "jetbrains"}} {
		err := validateExtensions(names)
		if err == nil {
			t.Fatalf("validateExtensions(%v) succeeded", names)
		}
		if names[0] == "unknown" && (!strings.Contains(err.Error(), "Available integrations:\n  jetbrains\n  vscode") || !strings.Contains(err.Error(), "Usage:")) {
			t.Fatalf("validateExtensions(%v) = %v", names, err)
		}
	}
}
