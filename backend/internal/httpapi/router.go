// Package httpapi is the constrained inbound HTTP adapter. It depends only on
// the shared application boundary and transport-safe platform services.
package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lyming99/autoplan/backend/internal/application"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
)

var (
	ErrRouterDependency = errors.New("router dependency is missing")
	ErrInvalidRoute     = errors.New("route registration is invalid")
	ErrDuplicateRoute   = errors.New("route is already registered")
)

// Endpoint receives the shared legacy application boundary. Versioned routes
// may close over a narrower application service, but never a repository,
// runtime adapter, or platform implementation from Router.
type Endpoint func(application.Boundary, http.ResponseWriter, *http.Request)

type RouterOptions struct {
	Application    application.Boundary
	Logger         logging.Logger
	Clock          logging.Clock
	RequestIDs     RequestIDSource
	BodyLimitBytes int64
	RequestTimeout time.Duration
}

type Router struct {
	mu             sync.RWMutex
	application    application.Boundary
	logger         logging.Logger
	clock          logging.Clock
	bodyLimitBytes int64
	requestTimeout time.Duration
	routes         map[string]map[string]Endpoint
	handler        http.Handler
}

func NewRouter(options RouterOptions) (*Router, error) {
	if options.RequestTimeout == 0 {
		options.RequestTimeout = DefaultRequestTimeout
	}
	if options.Application == nil || options.Logger == nil || options.Clock == nil ||
		options.BodyLimitBytes <= 0 || options.BodyLimitBytes > config.MaximumBodyLimit ||
		options.RequestTimeout < 0 || options.RequestTimeout > MaximumRequestTimeout {
		return nil, ErrRouterDependency
	}
	if options.RequestIDs == nil {
		options.RequestIDs = CryptoRequestIDs{}
	}
	router := &Router{
		application: options.Application, logger: options.Logger, clock: options.Clock,
		bodyLimitBytes: options.BodyLimitBytes, requestTimeout: options.RequestTimeout,
		routes: make(map[string]map[string]Endpoint),
	}
	dispatch := http.HandlerFunc(router.dispatch)
	router.handler = withHeadResponse(withRequestID(options.RequestIDs,
		withRecovery(options.Logger, options.Clock, withRequestTimeout(options.RequestTimeout, dispatch))))
	return router, nil
}

// Handle registers an exact path and method without implicit ServeMux prefix
// behavior.
func (router *Router) Handle(method, path string, endpoint Endpoint) error {
	if !validMethod(method) || !validRoute(path) || strings.ContainsAny(path, "{}") || endpoint == nil {
		return ErrInvalidRoute
	}
	return router.register(method, path, endpoint)
}

// HandlePattern registers a versioned path with one or two bounded resource
// identifiers. Exact routes retain priority over patterns.
func (router *Router) HandlePattern(method, pattern string, endpoint Endpoint) error {
	if !validMethod(method) || !validResourceRoutePattern(pattern) || endpoint == nil {
		return ErrInvalidRoute
	}
	return router.register(method, pattern, endpoint)
}

func (router *Router) register(method, path string, endpoint Endpoint) error {
	router.mu.Lock()
	defer router.mu.Unlock()
	methods := router.routes[path]
	if methods == nil {
		methods = make(map[string]Endpoint)
		router.routes[path] = methods
	}
	if _, exists := methods[method]; exists {
		return ErrDuplicateRoute
	}
	methods[method] = endpoint
	return nil
}

func (router *Router) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	router.handler.ServeHTTP(writer, request)
}

func (router *Router) dispatch(writer http.ResponseWriter, request *http.Request) {
	router.mu.RLock()
	route, methods := router.match(request.URL.Path)
	endpoint := methods[request.Method]
	methodsForError := allowedMethods(methods)
	router.mu.RUnlock()

	if methods == nil {
		route = "unmatched"
	}
	if state, _ := request.Context().Value(requestStateKey{}).(*requestState); state != nil {
		state.route = route
	}
	if request.Method == http.MethodOptions && methods != nil {
		origin := request.Header.Get("Origin")
		if origin != "" {
			writer.Header().Set("Vary", "Origin")
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		writer.Header().Set("Access-Control-Allow-Methods", joinMethods(methodsForError))
		if requestedHeaders := request.Header.Get("Access-Control-Request-Headers"); requestedHeaders != "" {
			writer.Header().Set("Access-Control-Allow-Headers", requestedHeaders)
		}
		writer.WriteHeader(http.StatusNoContent)
		return
	}

	var target http.Handler
	if methods == nil {
		target = http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			WriteError(writer, request, NewAPIError(CodeNotFound, nil))
		})
	} else if endpoint == nil {
		target = http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Allow", joinMethods(methodsForError))
			WriteError(writer, request, NewAPIError(
				CodeMethodNotAllowed,
				&ErrorDetails{AllowedMethods: methodsForError},
			))
		})
	} else {
		target = http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.Body != nil {
				request.Body = http.MaxBytesReader(writer, request.Body, router.bodyLimitBytes)
			}
			endpoint(router.application, writer, request)
		})
	}
	withAccessLog(router.logger, router.clock, route, target).ServeHTTP(writer, request)
}

func (router *Router) match(path string) (string, map[string]Endpoint) {
	if methods := router.routes[path]; methods != nil {
		return path, methods
	}
	patterns := make([]string, 0, len(router.routes))
	for candidate := range router.routes {
		if strings.Contains(candidate, "{") {
			patterns = append(patterns, candidate)
		}
	}
	sort.Strings(patterns)
	for _, pattern := range patterns {
		if resourceRoutePatternMatches(pattern, path) {
			return pattern, router.routes[pattern]
		}
	}
	return "unmatched", nil
}

func validResourceRoutePattern(value string) bool {
	if !validRoute(value) {
		return false
	}
	identifiers := 0
	seen := make(map[string]struct{}, 2)
	for _, segment := range strings.Split(value, "/") {
		if !strings.ContainsAny(segment, "{}") {
			continue
		}
		switch segment {
		case "{project_id}", "{operation_id}", "{intake_id}", "{attachment_id}", "{script_id}", "{executor_id}", "{action}",
			"{conversation_id}", "{message_id}", "{ai_config_id}", "{claude_config_id}", "{plan_id}", "{task_id}", "{intake_type}", "{id}":
			identifiers++
			if _, duplicate := seen[segment]; duplicate {
				return false
			}
			seen[segment] = struct{}{}
		case "{conversation_id}:stop":
			identifiers++
			if _, duplicate := seen["{conversation_id}"]; duplicate {
				return false
			}
			seen["{conversation_id}"] = struct{}{}
		default:
			return false
		}
	}
	_, hasPlanID := seen["{plan_id}"]
	_, hasTaskID := seen["{task_id}"]
	if hasPlanID && hasTaskID {
		return false
	}
	return identifiers > 0 && identifiers <= 3
}

func resourceRoutePatternMatches(pattern, value string) bool {
	patternSegments := strings.Split(pattern, "/")
	valueSegments := strings.Split(value, "/")
	if len(patternSegments) != len(valueSegments) {
		return false
	}
	for index := range patternSegments {
		switch patternSegments[index] {
		case "{project_id}", "{operation_id}", "{intake_id}", "{attachment_id}", "{script_id}", "{executor_id}", "{action}",
			"{conversation_id}", "{message_id}", "{ai_config_id}", "{claude_config_id}", "{plan_id}", "{task_id}", "{intake_type}", "{id}":
			if valueSegments[index] == "" {
				return false
			}
		case "{conversation_id}:stop":
			if !strings.HasSuffix(valueSegments[index], ":stop") || strings.TrimSuffix(valueSegments[index], ":stop") == "" {
				return false
			}
		default:
			if patternSegments[index] != valueSegments[index] {
				return false
			}
		}
	}
	return true
}

func (router *Router) BodyLimitBytes() int64 { return router.bodyLimitBytes }

func (router *Router) RequestTimeout() time.Duration { return router.requestTimeout }

func joinMethods(methods []string) string {
	result := ""
	for index, method := range methods {
		if index > 0 {
			result += ", "
		}
		result += method
	}
	return result
}
