// Package repository defines persistence ports consumed by application services.
package repository

import (
	"context"
	"errors"

	domainautomation "github.com/lyming99/autoplan/backend/internal/domain/automation"
	domainchat "github.com/lyming99/autoplan/backend/internal/domain/chat"
	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
)

var (
	ErrNotConfigured       = errors.New("repository is not configured")
	ErrNotFound            = errors.New("repository row not found")
	ErrUnsafePath          = errors.New("repository path is not authorized")
	ErrInvalidStore        = errors.New("repository database is invalid")
	ErrSchemaDrift         = errors.New("repository schema drift detected")
	ErrSourceChanged       = errors.New("repository source changed")
	ErrClosed              = errors.New("repository is closed")
	ErrWriterUnauthorized  = errors.New("repository writer is not authorized")
	ErrTransaction         = errors.New("repository transaction failed")
	ErrCommit              = errors.New("repository commit failed")
	ErrRollback            = errors.New("repository rollback failed")
	ErrVersionRequired     = errors.New("repository version required")
	ErrVersionConflict     = errors.New("repository version conflict")
	ErrProjectRunning      = errors.New("repository project running")
	ErrRelationConflict    = errors.New("repository relation conflict")
	ErrDuplicate           = errors.New("repository duplicate")
	ErrSettingNotWritable  = errors.New("repository setting is not writable")
	ErrIdempotencyKeyReuse = errors.New("repository idempotency key reused")
	ErrInvalidIntake       = errors.New("repository intake is invalid")
	ErrProjectMismatch     = errors.New("repository project ownership mismatch")
	ErrRequirementMissing  = errors.New("repository linked requirement not found")
	ErrPlanMissing         = errors.New("repository linked plan not found")
	ErrLinkConflict        = errors.New("repository intake plan link conflicts")
	ErrInvalidPlan         = errors.New("repository plan is invalid")
	ErrInvalidTask         = errors.New("repository plan task is invalid")
	ErrInvalidEvent        = errors.New("repository event is invalid")
	ErrPlanOrderConflict   = errors.New("repository plan order conflicts")
	ErrInvalidAutomation   = errors.New("repository automation is invalid")
	ErrAutomationConflict  = errors.New("repository automation conflicts")
	ErrCapabilityDisabled  = errors.New("repository capability is disabled")
	ErrInvalidModelUsage   = errors.New("repository model usage is invalid")
)

type Project = domainproject.Project
type Setting = domainconfig.Setting
type ProjectState = domainconfig.ProjectState
type LoopConfig = domainconfig.LoopConfig
type Intake = domainintake.Intake
type IntakeType = domainintake.Type
type IntakeStatus = domainintake.Status
type IntakePlanLink = domainintake.PlanLink
type Plan = domainplan.Plan
type PlanTask = domainplan.Task
type ModelUsageRecord = domainmodelusage.Record
type ModelUsageAggregate = domainmodelusage.Aggregate

// IntakePlanAction is the closed persistence command used by the Intake
// application service for its linked-plan controls. It deliberately carries
// only resource identity and user-authored task text; the repository chooses
// the affected linked plan inside the same transaction as the state change.
type IntakePlanAction string

const (
	IntakePlanInterrupt IntakePlanAction = "interrupt"
	IntakePlanResume    IntakePlanAction = "resume"
	IntakePlanAppend    IntakePlanAction = "append_task"
)

type IntakePlanActionInput struct {
	ProjectID int64
	Type      domainintake.Type
	IntakeID  int64
	Action    IntakePlanAction
	Title     string
	UpdatedAt string
}

type IntakePlanActionResult struct {
	PlanIDs         []int64
	AffectedPlanIDs []int64
	AffectedTasks   int64
	PlanID          int64
	TaskID          int64
	TaskKey         string
	Reactivated     bool
	UpdatedAt       string
}

// IntakePlanActions is an optional, narrow transaction extension. Keeping it
// separate from IntakeWriteTransaction avoids granting unrelated P06 test
// doubles or callers any arbitrary Plan mutation capability.
type IntakePlanActions interface {
	ApplyIntakePlanAction(context.Context, IntakePlanActionInput) (IntakePlanActionResult, error)
}

type GeneratedPlanTask struct {
	Key, Title, RawLine, Scope string
	SortOrder                  int64
}

type GeneratedPlanInput struct {
	ProjectID                   int64
	IntakeType                  domainintake.Type
	IntakeID                    int64
	Status                      domainplan.Status
	IssueHash, FilePath, Digest string
	AgentCLI                    domainintake.AgentCLIConfig
	PlanGeneration              domainintake.PlanGenerationConfig
	GenerationDurationMS        int64
	Tasks                       []GeneratedPlanTask
	CreatedAt                   string
}

type GeneratedPlanWriter interface {
	CreateGeneratedPlan(context.Context, GeneratedPlanInput) (int64, error)
}

type LoopPlanTaskClaim struct {
	Plan      domainplan.Plan
	Task      domainplan.Task
	SessionID string
}

type LoopPlanTaskCompletion struct {
	ProjectID   int64
	PlanID      int64
	TaskID      int64
	OperationID string
	Succeeded   bool
	Cancelled   bool
	FailureCode string
	Digest      string
	SessionID   string
	FinishedAt  string
	DurationMS  int64
}

// PlanTaskStopOutcome is the closed set of persistence decisions for a task
// stop request. Business rejections are returned as data so callers can map
// them without depending on database-specific errors.
type PlanTaskStopOutcome string

const (
	PlanTaskStopRequested         PlanTaskStopOutcome = "stop_requested"
	PlanTaskStopAlreadyRequested  PlanTaskStopOutcome = "already_stopping"
	PlanTaskStopNotFound          PlanTaskStopOutcome = "not_found"
	PlanTaskStopOwnershipMismatch PlanTaskStopOutcome = "ownership_mismatch"
	PlanTaskStopNotRunning        PlanTaskStopOutcome = "not_running"
	PlanTaskStopTerminal          PlanTaskStopOutcome = "terminal"
)

type PlanTaskStopInput struct {
	ProjectID int64
	PlanID    int64
	TaskID    int64
	UpdatedAt string
}

type PlanTaskStopResult struct {
	Outcome        PlanTaskStopOutcome
	PreviousStatus domainplan.TaskStatus
	Status         domainplan.TaskStatus
	OperationID    string
	Changed        bool
}

// PlanTaskStopper validates the complete task target and persists the stop
// request atomically. It is separate from the autonomous executor surface so
// callers that only claim and finish tasks do not receive stop authority.
type PlanTaskStopper interface {
	RequestPlanTaskStop(context.Context, PlanTaskStopInput) (PlanTaskStopResult, error)
}

type DraftPlanTaskActivation struct {
	ProjectID, PlanID, TaskID int64
	OperationID, ActivatedAt  string
}

type DraftPlanTaskActivator interface {
	ActivateDraftPlanTask(context.Context, DraftPlanTaskActivation) (bool, error)
}

// LoopPlanTaskWriter is the bounded persistence surface used by the daemon's
// autonomous plan executor. It exposes lifecycle transitions only; callers
// cannot issue SQL or mutate arbitrary plan fields.
type LoopPlanTaskWriter interface {
	ClaimNextPlanTask(context.Context, int64, string, string) (LoopPlanTaskClaim, bool, error)
	FinishPlanTask(context.Context, LoopPlanTaskCompletion) error
}
type Event = domainevent.Event
type Script = domainautomation.Script
type Executor = domainautomation.Executor
type Conversation = domainchat.Conversation
type ChatMessage = domainchat.Message

type Readiness interface {
	Check(context.Context) error
}

// DatabaseOwnerProof is implemented by the live database runtime. A writer is
// never constructed from a path and cannot open or discover a database itself.
type DatabaseOwnerProof interface {
	DatabaseID() string
}

type Projects interface {
	ListProjects(context.Context) ([]Project, error)
	GetProject(context.Context, int64) (Project, bool, error)
}

type Settings interface {
	ListSettings(context.Context, string) ([]Setting, error)
}

type ProjectStates interface {
	GetProjectState(context.Context, int64) (ProjectState, bool, error)
}

type ReadOnly interface {
	Readiness
	Projects
	Settings
	ProjectStates
	Close() error
}

type SettingMutation struct {
	Key             string
	Value           string
	ExpectedVersion int64
}

type IdempotencyRecord struct {
	OperationID string
	ProjectID   *int64
	Route       string
	RequestID   string
	Scope       string
	Key         string
	RequestHash string
	Status      string
	ResultJSON  *string
	ErrorJSON   *string
	Version     int64
	CreatedAt   string
	UpdatedAt   string
}

type IntakeQueries interface {
	ListIntakes(context.Context, domainintake.ListOptions) ([]domainintake.Intake, error)
	GetIntake(context.Context, int64, domainintake.Type, int64) (domainintake.Intake, bool, error)
	FindDuplicateIntake(context.Context, domainintake.DuplicateQuery) (domainintake.Intake, bool, error)
	ListPlanLinksForIntake(context.Context, int64, domainintake.Type, int64) ([]domainintake.PlanLink, error)
	ListIntakesForPlan(context.Context, int64, int64) ([]domainintake.IntakeRef, error)
}

type IntakeMutations interface {
	CreateIntake(context.Context, domainintake.Create) (domainintake.Intake, error)
	UpdateIntake(context.Context, int64, domainintake.Type, int64, domainintake.Update) (domainintake.Intake, error)
	SetIntakeAcceptance(context.Context, int64, domainintake.Type, int64, *string, string) (domainintake.Intake, error)
	ReplacePlanLinks(context.Context, int64, domainintake.Type, int64, []domainintake.PlanLinkInput, string) ([]domainintake.PlanLink, error)
	DeletePlanLinksForIntake(context.Context, int64, domainintake.Type, int64, string) error
	DeletePlanAndSyncIntakes(context.Context, int64, int64, string) (domainintake.PlanDeleteResult, error)
	DeleteIntake(context.Context, int64, domainintake.Type, int64, string) (domainintake.DeleteResult, error)
	AppendIntakeEvent(context.Context, domainintake.PendingEvent) error
}

type Intakes interface {
	IntakeQueries
	IntakeMutations
}

// IntakeWriteTransaction extends the stable P05 transaction surface without
// forcing existing project/config test doubles to implement P06 capabilities.
type IntakeWriteTransaction interface {
	WriteTransaction
	Intakes
}

// WriteTransaction exposes only bounded domain operations. It deliberately
// omits arbitrary Exec/Query capabilities.
type WriteTransaction interface {
	ListProjects(context.Context) ([]Project, error)
	GetProject(context.Context, int64) (Project, bool, error)
	CreateProject(context.Context, domainproject.Create, string) (Project, ProjectState, error)
	UpdateProject(context.Context, int64, domainproject.Update, string) (Project, error)
	DeleteProject(context.Context, int64) error

	ListSettings(context.Context, string) ([]Setting, error)
	PutSetting(context.Context, SettingMutation) (Setting, bool, error)
	GetProjectState(context.Context, int64) (ProjectState, bool, error)
	PutLoopConfig(context.Context, int64, int64, LoopConfig, string) (ProjectState, bool, error)
	ResetLoopConfig(context.Context, int64, int64, string) (ProjectState, bool, error)

	FindIdempotency(context.Context, string, string) (IdempotencyRecord, bool, error)
	ReserveIdempotency(context.Context, IdempotencyRecord) error
	CompleteIdempotency(context.Context, string, string, string, *string, *string, string) error
}

type Transactional interface {
	Readiness
	Transact(context.Context, func(WriteTransaction) error) error
	Close() error
}

// ModelUsageQueries and ModelUsageMutations form a narrow accounting port.
// The aggregate is always project scoped and the write is idempotent by the
// record's invocation key.
type ModelUsageQueries interface {
	AggregateModelUsage(context.Context, int64, string, string) (domainmodelusage.Aggregate, error)
}

type ModelUsageMutations interface {
	RecordModelUsage(context.Context, domainmodelusage.Record) (bool, error)
}

type ModelUsageWriteTransaction interface {
	WriteTransaction
	ModelUsageQueries
	ModelUsageMutations
}

type ModelUsageTransactional interface {
	Readiness
	TransactModelUsage(context.Context, func(ModelUsageWriteTransaction) error) error
	Close() error
}

type IntakeTransactional interface {
	Readiness
	TransactIntake(context.Context, func(IntakeWriteTransaction) error) error
	Close() error
}

// PlanQueries are intentionally project-scoped. No caller can resolve a task
// or event by ID without simultaneously proving the owning project.
type PlanQueries interface {
	ListPlans(context.Context, domainplan.ListOptions) ([]domainplan.Plan, error)
	GetPlan(context.Context, int64, int64) (domainplan.Plan, bool, error)
	ListPlanTasks(context.Context, int64, int64) ([]domainplan.Task, error)
	GetPlanTask(context.Context, int64, int64, int64) (domainplan.Task, bool, error)
	ListEvents(context.Context, domainevent.ListOptions) ([]domainevent.Event, error)
}

// PlanMutations contain bounded aggregate persistence operations. StopPlan is
// deliberately available only through PlanWriteTransaction so its plan/task
// transition can be committed with the caller's audit event.
type PlanMutations interface {
	ReorderPlans(context.Context, domainplan.Reorder) ([]domainplan.Plan, error)
	SetPlanAcceptance(context.Context, domainplan.AcceptanceUpdate) (domainplan.Plan, error)
	SetPlanTaskAcceptance(context.Context, domainplan.AcceptanceUpdate) (domainplan.Task, error)
	RedoPlan(context.Context, domainplan.PlanRedo) (domainplan.Plan, error)
	RedoPlanTask(context.Context, domainplan.TaskRedo) (domainplan.Task, error)
	StopPlan(context.Context, domainplan.PlanStop) (domainplan.PlanStopResult, error)
	DeletePlanAggregate(context.Context, domainplan.Delete) (domainplan.DeleteResult, error)
	AppendEvent(context.Context, domainevent.PendingEvent) error
}

type Plans interface {
	PlanQueries
	PlanMutations
}

// PlanWriteTransaction is a narrow extension so existing P05/P06 transaction
// doubles do not need to implement the P07 persistence surface.
type PlanWriteTransaction interface {
	WriteTransaction
	Plans
	// Plan acceptance is the authority for linked intake acceptance. Keep the
	// bounded intake reads/writes on this same transaction so the plan, intake,
	// compatibility event, and outbox record commit or roll back together.
	GetIntake(context.Context, int64, domainintake.Type, int64) (domainintake.Intake, bool, error)
	ListPlanLinksForIntake(context.Context, int64, domainintake.Type, int64) ([]domainintake.PlanLink, error)
	ListIntakesForPlan(context.Context, int64, int64) ([]domainintake.IntakeRef, error)
	SetIntakeAcceptance(context.Context, int64, domainintake.Type, int64, *string, string) (domainintake.Intake, error)
}

type PlanTransactional interface {
	Readiness
	TransactPlans(context.Context, func(PlanWriteTransaction) error) error
	Close() error
}

// AutomationQueries keeps every Script and Executor lookup project scoped.
// Callers cannot discover an automation record by its ID alone.
type AutomationQueries interface {
	ListScripts(context.Context, domainautomation.ListOptions) ([]domainautomation.Script, error)
	GetScript(context.Context, int64, int64) (domainautomation.Script, bool, error)
	ListExecutors(context.Context, domainautomation.ListOptions) ([]domainautomation.Executor, error)
	GetExecutor(context.Context, int64, int64) (domainautomation.Executor, bool, error)
}

// AutomationMutations is intentionally pure persistence. Runtime execution,
// process management, hook dispatch, and scheduling are outside P002.
type AutomationMutations interface {
	CreateScript(context.Context, domainautomation.ScriptCreate) (domainautomation.Script, error)
	UpdateScript(context.Context, domainautomation.ScriptUpdate) (domainautomation.Script, error)
	DeleteScript(context.Context, domainautomation.Delete) (domainautomation.Script, error)
	ToggleScript(context.Context, domainautomation.Toggle) (domainautomation.Script, error)
	ReorderScripts(context.Context, domainautomation.Reorder) ([]domainautomation.Script, error)

	CreateExecutor(context.Context, domainautomation.ExecutorCreate) (domainautomation.Executor, error)
	UpdateExecutor(context.Context, domainautomation.ExecutorUpdate) (domainautomation.Executor, error)
	DeleteExecutor(context.Context, domainautomation.Delete) (domainautomation.Executor, error)
	ToggleExecutor(context.Context, domainautomation.Toggle) (domainautomation.Executor, error)
	ReorderExecutors(context.Context, domainautomation.Reorder) ([]domainautomation.Executor, error)
	ImportExecutors(context.Context, domainautomation.Import) ([]domainautomation.Executor, error)
}

type Automation interface {
	AutomationQueries
	AutomationMutations
}

// AutomationWriteTransaction extends the existing bounded writer with P002
// operations, preserving compatibility for prior transaction test doubles.
type AutomationWriteTransaction interface {
	WriteTransaction
	Automation
}

type AutomationTransactional interface {
	Readiness
	TransactAutomation(context.Context, func(AutomationWriteTransaction) error) error
	Close() error
}

// ChatQueries is project scoped throughout. Conversation and message IDs are
// never resolved without their project ownership proof.
type ChatQueries interface {
	ListConversations(context.Context, domainchat.ConversationListOptions) ([]domainchat.Conversation, string, error)
	GetConversation(context.Context, int64, int64) (domainchat.Conversation, bool, error)
	ListChatMessages(context.Context, domainchat.MessageListOptions) ([]domainchat.Message, string, error)
}

type ChatMutations interface {
	CreateConversation(context.Context, int64, domainchat.ConversationInput, string) (domainchat.Conversation, error)
	UpdateConversation(context.Context, int64, int64, domainchat.ConversationInput, string) (domainchat.Conversation, error)
	UnlinkConversationAIConfig(context.Context, int64, int64, string) (domainchat.Conversation, error)
	DeleteConversation(context.Context, int64, int64) (int64, error)
	AppendChatMessage(context.Context, domainchat.MessageInput) (domainchat.Message, error)
}

type Chats interface {
	ChatQueries
	ChatMutations
}

type StaticConfigQueries interface {
	ListAIConfigs(context.Context) ([]domainconfig.AIConfig, error)
	GetAIConfig(context.Context, int64) (domainconfig.AIConfig, bool, error)
	ListClaudeCLIConfigs(context.Context) ([]domainconfig.ClaudeCLIConfig, error)
	GetClaudeCLIConfig(context.Context, int64) (domainconfig.ClaudeCLIConfig, bool, error)
	GetMCPConfig(context.Context) (domainconfig.MCPConfig, error)
}

type StaticConfigMutations interface {
	CreateAIConfig(context.Context, domainconfig.AIConfigInput, string) (domainconfig.AIConfig, error)
	UpdateAIConfig(context.Context, int64, int64, domainconfig.AIConfigInput, string) (domainconfig.AIConfig, error)
	DeleteAIConfig(context.Context, int64, int64, string) error
	CreateClaudeCLIConfig(context.Context, domainconfig.ClaudeCLIConfigInput, string) (domainconfig.ClaudeCLIConfig, error)
	UpdateClaudeCLIConfig(context.Context, int64, int64, domainconfig.ClaudeCLIConfigInput, string) (domainconfig.ClaudeCLIConfig, error)
	DeleteClaudeCLIConfig(context.Context, int64, int64, string) error
	SetDefaultClaudeCLIConfig(context.Context, int64, int64, string) (domainconfig.ClaudeCLIConfig, error)
	SaveMCPConfig(context.Context, domainconfig.MCPInput) (domainconfig.MCPConfig, error)
}

type StaticConfigs interface {
	StaticConfigQueries
	StaticConfigMutations
}

// ChatWriteTransaction is the P003 bounded transaction surface. It includes
// automation queries because the snapshot can render both static aggregates
// after a successful chat/config mutation without introducing a SQL escape hatch.
type ChatWriteTransaction interface {
	WriteTransaction
	Chats
	StaticConfigs
	AutomationQueries
}

type ChatTransactional interface {
	Readiness
	TransactChat(context.Context, func(ChatWriteTransaction) error) error
	Close() error
}

// Unavailable is the safe default. It discovers and opens nothing.
type Unavailable struct{}

func (Unavailable) Check(context.Context) error { return ErrNotConfigured }
