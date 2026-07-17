package mcp

import (
	"crypto/hmac"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Authenticator owns the in-memory bootstrap session and separately resolved
// bearer token used by the HTTP transport. Neither is serializable or allowed
// in a DTO, URL, log, audit event, argv, or stdio diagnostic.
type Authenticator struct {
	session []byte
	token   []byte
	origins map[string]struct{}
}

func newAuthenticator(sessionToken, authToken []byte, allowedOrigins []string) (*Authenticator, error) {
	if !validCredential(sessionToken) || len(authToken) > 0 && !validCredential(authToken) {
		return nil, ErrInvalidConfiguration
	}
	result := &Authenticator{
		session: append([]byte(nil), sessionToken...),
		token:   append([]byte(nil), authToken...),
		origins: make(map[string]struct{}, len(allowedOrigins)),
	}
	for _, origin := range allowedOrigins {
		canonical, ok := canonicalOrigin(origin)
		if !ok {
			result.Close()
			return nil, ErrInvalidConfiguration
		}
		result.origins[canonical] = struct{}{}
	}
	return result, nil
}

func (auth *Authenticator) Close() {
	if auth == nil {
		return
	}
	for index := range auth.session {
		auth.session[index] = 0
	}
	for index := range auth.token {
		auth.token[index] = 0
	}
	auth.token = nil
	auth.session = nil
	auth.origins = nil
}

func (auth *Authenticator) HasToken() bool { return auth != nil && len(auth.token) != 0 }

func (auth *Authenticator) MaskedToken() string {
	if auth == nil {
		return ""
	}
	return maskedToken(auth.token)
}

func (auth *Authenticator) authorizeHTTP(request *http.Request, expectedHost string, expectedPort int) bool {
	if auth == nil || request == nil || request.URL == nil || request.URL.IsAbs() || request.URL.Host != "" ||
		request.URL.User != nil || !matchesAuthority(request.Host, expectedHost, expectedPort) ||
		hasForwardedHeaders(request.Header) || hasURLCredentials(request.URL) || hasSensitiveHeaders(request.Header) {
		return false
	}
	if !auth.HasToken() {
		originValues := request.Header.Values("Origin")
		if len(originValues) == 0 {
			return true
		}
		if len(originValues) != 1 {
			return false
		}
		origin, valid := canonicalOrigin(originValues[0])
		if !valid {
			return false
		}
		_, allowed := auth.origins[origin]
		return allowed
	}
	originValues := request.Header.Values("Origin")
	if len(originValues) != 1 {
		return false
	}
	origin, valid := canonicalOrigin(originValues[0])
	if !valid {
		return false
	}
	if _, allowed := auth.origins[origin]; !allowed {
		return false
	}
	sessions := request.Header.Values("X-Autoplan-Session")
	if len(sessions) != 1 || !hmac.Equal([]byte(sessions[0]), auth.session) {
		return false
	}
	values := request.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return false
	}
	presented := strings.TrimPrefix(values[0], "Bearer ")
	if presented == "" || strings.TrimSpace(presented) != presented || strings.ContainsAny(presented, "\r\n") {
		return false
	}
	return hmac.Equal([]byte(presented), auth.token)
}

func validCredential(value []byte) bool {
	return len(value) >= 16 && len(value) <= 512 && !containsControl(value)
}

func containsControl(value []byte) bool {
	for _, current := range value {
		if current < 0x21 || current == 0x7f {
			return true
		}
	}
	return false
}

func matchesAuthority(value, expectedHost string, expectedPort int) bool {
	host, portText, err := net.SplitHostPort(value)
	if err != nil || host != expectedHost || expectedHost != DefaultHost {
		return false
	}
	port, err := strconv.Atoi(portText)
	return err == nil && port == expectedPort && port > 0 && strconv.Itoa(port) == portText &&
		value == net.JoinHostPort(expectedHost, portText)
}

func hasForwardedHeaders(header http.Header) bool {
	for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
		if len(header.Values(name)) != 0 {
			return true
		}
	}
	return false
}

func hasURLCredentials(value *url.URL) bool {
	if value == nil || value.User != nil || value.RawQuery == "" {
		return value != nil && value.User != nil
	}
	query, err := url.ParseQuery(value.RawQuery)
	if err != nil {
		return true
	}
	for key := range query {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "auth" || key == "token" || key == "authorization" || key == "session" || key == "cookie" || strings.Contains(key, "secret") {
			return true
		}
	}
	return false
}

func hasSensitiveHeaders(header http.Header) bool {
	for name := range header {
		lower := strings.ToLower(name)
		if lower == "authorization" || lower == "origin" || lower == "content-type" || lower == "content-length" ||
			lower == "accept" || lower == "user-agent" || lower == "idempotency-key" || lower == "mcp-session-id" || lower == "x-autoplan-session" {
			continue
		}
		if lower == "cookie" || lower == "set-cookie" || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "api-key") {
			return true
		}
	}
	return false
}
