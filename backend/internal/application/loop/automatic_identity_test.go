package loop

import (
	"strings"
	"testing"
)

func TestAutomaticIdentityDoesNotReplayAfterRuntimeRestart(t *testing.T) {
	first := newRuntimeService(Dependencies{})
	second := newRuntimeService(Dependencies{})

	firstRequest, firstKey := first.nextAutomaticIdentity(string(CommandLoopRunOnce), 7)
	secondRequest, secondKey := second.nextAutomaticIdentity(string(CommandLoopRunOnce), 7)
	if firstRequest == secondRequest || firstKey == secondKey {
		t.Fatalf("automatic identities collided across runtime instances: request=%q key=%q", firstRequest, firstKey)
	}
	if !strings.HasSuffix(firstRequest, "-1") || !strings.HasSuffix(firstKey, "-1") {
		t.Fatalf("first runtime sequence should start at one: request=%q key=%q", firstRequest, firstKey)
	}

	nextRequest, nextKey := first.nextAutomaticIdentity(string(CommandLoopRunOnce), 7)
	if !strings.HasSuffix(nextRequest, "-2") || !strings.HasSuffix(nextKey, "-2") {
		t.Fatalf("runtime sequence should advance: request=%q key=%q", nextRequest, nextKey)
	}
}
