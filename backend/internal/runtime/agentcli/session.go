package agentcli

import (
	"regexp"
	"strings"
)

type SessionMode string

const (
	SessionNew       SessionMode = "new"
	SessionResume    SessionMode = "resume"
	SessionContinue  SessionMode = "continue"
	SessionSpecified SessionMode = "session-id"
)

type Session struct {
	ID          string
	RequestedID string
	Mode        SessionMode
	State       string
	Fallback    bool
	Title       string
}

var codexSessionID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var agentSessionID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)

// NormalizeSessionID is the safe persistence/argv boundary for callers that
// own session lifecycle state. Invalid provider-specific identifiers collapse
// to an empty value and must therefore start a new session.
func NormalizeSessionID(provider Provider, value string) string {
	return normalizeSessionID(provider, value)
}

func normalizeSession(provider Provider, requested Session) (Session, error) {
	if !provider.SupportsSession() {
		return Session{}, nil
	}
	requested.ID = normalizeSessionID(provider, requested.ID)
	requested.RequestedID = normalizeSessionID(provider, requested.RequestedID)
	requested.Title = normalizeSessionTitle(requested.Title)
	if requested.Mode == "" {
		if requested.RequestedID != "" || requested.ID != "" {
			requested.Mode = SessionResume
		} else {
			requested.Mode = SessionNew
		}
	}
	switch requested.Mode {
	case SessionNew:
		requested.ID = ""
	case SessionResume:
		if requested.RequestedID == "" {
			requested.RequestedID = requested.ID
		}
		if requested.RequestedID == "" {
			requested.Mode = SessionNew
		} else {
			requested.ID = requested.RequestedID
		}
	case SessionContinue:
		if provider != ProviderClaude {
			return Session{}, ErrInvalidRequest
		}
		requested.ID = ""
		requested.RequestedID = ""
	case SessionSpecified:
		if provider != ProviderClaude || requested.ID == "" {
			return Session{}, ErrInvalidRequest
		}
	default:
		return Session{}, ErrInvalidRequest
	}
	if requested.State == "" {
		requested.State = string(requested.Mode)
	}
	return requested, nil
}

func fallbackSession(session Session) Session {
	requested := session.RequestedID
	if requested == "" {
		requested = session.ID
	}
	return Session{RequestedID: requested, Mode: SessionNew, State: "fallback-new", Fallback: true, Title: session.Title}
}

func normalizeSessionID(provider Provider, value string) string {
	text := strings.TrimSpace(value)
	if provider == ProviderCodex {
		if !codexSessionID.MatchString(text) {
			return ""
		}
		return strings.ToLower(text)
	}
	if !agentSessionID.MatchString(text) {
		return ""
	}
	return text
}

func normalizeSessionTitle(value string) string {
	text := strings.TrimSpace(value)
	if len(text) > maximumSessionTitle {
		text = text[:maximumSessionTitle]
	}
	if text != "" && (!validPrompt(text) || strings.ContainsAny(text, "\r\n")) {
		return ""
	}
	return text
}
