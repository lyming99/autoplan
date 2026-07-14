// Package operations provides the shared P10 Operation use cases. Transports
// receive typed commands and results only; SQLite transactions remain behind
// this application boundary.
package operations

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var (
	ErrUnavailable          = errors.New("operation application service unavailable")
	ErrInvalidCommand       = errors.New("operation command is invalid")
	ErrUnauthorized         = errors.New("operation caller is not authorized")
	ErrNotFound             = errors.New("operation was not found")
	ErrVersionConflict      = errors.New("operation version conflicts")
	ErrStateConflict        = errors.New("operation state conflicts")
	ErrIdempotencyConflict  = errors.New("operation idempotency conflicts")
	ErrHandlerUnavailable   = errors.New("operation handler is unavailable")
	ErrRecoveryNotClaimable = errors.New("operation recovery is not claimable")
)

var (
	opaquePattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	requestIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	operationTypePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$`)
	digestPattern        = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Caller has already been authenticated by a transport-specific adapter. The
// service still requires its project proof so a local route or operation ID
// cannot substitute for project authorization.
type Caller struct {
	ID        string
	ProjectID int64
}

func (caller Caller) authorizes(projectID int64) bool {
	return projectID > 0 && caller.ProjectID == projectID && opaquePattern.MatchString(caller.ID)
}

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

// Store is intentionally application-shaped. Its concrete SQLite adapter is
// local to this package, so REST/MCP/UI code cannot use arbitrary repository
// writes or raw SQL.
type Store interface {
	Check(context.Context) error
	ListProjects(context.Context) ([]repository.Project, error)
	Transact(context.Context, func(Transaction) error) error
}

type Transaction interface {
	Create(context.Context, domainoperation.Operation, string, json.RawMessage) (domainoperation.Operation, bool, error)
	Get(context.Context, int64, string) (domainoperation.Operation, bool, error)
	List(context.Context, ListQuery) ([]domainoperation.Operation, error)
	Transition(context.Context, Transition) (domainoperation.Operation, bool, error)
	RequestCancellation(context.Context, CancelRequest) (domainoperation.Operation, bool, error)
}

type ListQuery struct {
	ProjectID  int64
	Type       string
	Status     domainoperation.Status
	Limit      int
	Descending bool
}

type Transition struct {
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	Target          domainoperation.Status
	RequestID       string
	UpdatedAt       string
	Result          *json.RawMessage
	Error           *domainoperation.ErrorSummary
	Output          *domainoperation.OutputMetadata
	Payload         json.RawMessage
}

// TerminalResolution makes the terminal portion of the state machine
// explicit for callers that arbitrate a process exit against stop, timeout,
// cancellation, or startup recovery. Replaying the already committed terminal
// target is harmless; any competing terminal target is rejected.
type TerminalResolution struct {
	Disposition domainoperation.TransitionDisposition
	Current     domainoperation.Status
	Target      domainoperation.Status
}

func ResolveTerminal(current, target domainoperation.Status) TerminalResolution {
	resolution := TerminalResolution{Current: current, Target: target, Disposition: domainoperation.TransitionReject}
	if !target.Terminal() {
		return resolution
	}
	resolution.Disposition = domainoperation.ResolveTransition(current, target)
	return resolution
}

func (value TerminalResolution) Apply() bool {
	return value.Disposition == domainoperation.TransitionApply
}

func (value TerminalResolution) Replay() bool {
	return value.Disposition == domainoperation.TransitionNoop && value.Current.Terminal() && value.Current == value.Target
}

type CancelRequest struct {
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestID       string
	RequestedAt     string
}

func validCommandID(value string) bool { return opaquePattern.MatchString(value) }
func validRequestID(value string) bool { return requestIDPattern.MatchString(value) }
func validOperationType(value string) bool {
	return operationTypePattern.MatchString(value)
}
func validDigest(value string) bool { return digestPattern.MatchString(value) }

func nextTimestamp(clock Clock, previous string) string {
	now := clock.Now().UTC()
	if parsed, err := time.Parse(time.RFC3339Nano, previous); err == nil && !now.After(parsed) {
		now = parsed.Add(time.Millisecond)
	}
	return now.Format(time.RFC3339Nano)
}

func statusPayload(status domainoperation.Status) json.RawMessage {
	return json.RawMessage(`{"status":"` + string(status) + `"}`)
}
