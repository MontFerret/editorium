package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

// ts-proto builds Struct maps by assigning arbitrary JSON keys to plain JS
// objects. Use dictionaries for each accumulator so "__proto__" round-trips
// like every other bind key, including inside arrays and nested objects.
func generateVSCodeStructMaps(outputRoot string) error {
	path := filepath.Join(outputRoot, "google", "protobuf", "struct.pb.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	for _, change := range [][2]string{
		{"return { fields: {} };", "return { fields: Object.create(null) };"},
		{"      {},\n    );", "      Object.create(null),\n    );"},
		{"const object: { [key: string]: any } = {};", "const object: { [key: string]: any } = Object.create(null);"},
	} {
		before := []byte(change[0])
		if bytes.Count(source, before) != 1 {
			return fmt.Errorf("unexpected ts-proto Struct dictionary initializer %q", change[0])
		}
		source = bytes.Replace(source, before, []byte(change[1]), 1)
	}

	return os.WriteFile(path, source, 0o644)
}
