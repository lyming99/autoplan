package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	content, err := io.ReadAll(os.Stdin)
	if err != nil || len(content) == 0 {
		os.Exit(2)
	}
	// Real Codex sessions can emit thousands of diagnostic lines and terminal
	// control bytes on stderr while still returning a valid plan on stdout.
	// Keep the packaged business smoke representative of that behavior.
	for index := 0; index < 1100; index++ {
		fmt.Fprintf(os.Stderr, "inspection progress %04d\n", index)
	}
	_, _ = os.Stderr.Write([]byte{0})
	if strings.Contains(string(content), "AutoPlan's plan generator") {
		fmt.Print(`{"title":"Business smoke plan","summary":"Implement and verify the requested marker behavior","tasks":[{"title":"Implement marker behavior","scope":"src/marker.go","acceptance":"The marker behavior exists"},{"title":"Add regression coverage","scope":"src/marker_test.go","acceptance":"Regression tests cover the behavior"}],"finalValidation":"Run the complete test suite"}`)
		return
	}
	if err := os.WriteFile("autoplan-task-executed.txt", []byte("task execution reached the configured agent\n"), 0o600); err != nil {
		os.Exit(3)
	}
	fmt.Print("task completed")
}
