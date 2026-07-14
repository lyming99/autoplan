// Package snapshot assembles the transport-neutral Node-compatible AppSnapshot.
package snapshot

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	applicationevents "github.com/lyming99/autoplan/backend/internal/application/events"
	applicationexecutors "github.com/lyming99/autoplan/backend/internal/application/executors"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	applicationscripts "github.com/lyming99/autoplan/backend/internal/application/scripts"
	domainautomation "github.com/lyming99/autoplan/backend/internal/domain/automation"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type QueryStore interface {
	ListProjects(context.Context) ([]repository.Project, error)
	GetProject(context.Context, int64) (repository.Project, bool, error)
	ListSettings(context.Context, string) ([]repository.Setting, error)
	GetProjectState(context.Context, int64) (repository.ProjectState, bool, error)
}

type ReadSession func(context.Context, func(QueryStore) error) error

type AttachmentSnapshot struct {
	ID          int64
	DisplayName string
	Size        int64
	MIMEType    string
	DownloadURL string
}

type AttachmentSnapshotSource interface {
	ListAttachmentSnapshots(context.Context, int64) ([]AttachmentSnapshot, error)
}

type Assembler struct {
	read        ReadSession
	attachments AttachmentSnapshotSource
	scripts     *applicationscripts.Service
	executors   *applicationexecutors.Service
	operations  *applicationoperations.Service
	mcpRuntime  func() map[string]any
}

func New(read ReadSession) *Assembler { return &Assembler{read: read} }

func NewWithAttachments(read ReadSession, attachments AttachmentSnapshotSource) *Assembler {
	return &Assembler{read: read, attachments: attachments}
}

// NewWithAttachmentsAndScripts keeps static Script records in the repository
// while applying the Go runtime's project-scoped, redacted live overlay. The
// overlay is intentionally optional so snapshot reads remain usable before
// Script runtime dependencies are assembled.
func NewWithAttachmentsAndScripts(
	read ReadSession,
	attachments AttachmentSnapshotSource,
	scripts *applicationscripts.Service,
) *Assembler {
	return &Assembler{read: read, attachments: attachments, scripts: scripts}
}

// BindScripts completes bootstrap's Operation/Script cycle without requiring
// snapshot construction to own the runtime service or its process boundary.
func (assembler *Assembler) BindScripts(scripts *applicationscripts.Service) {
	if assembler == nil {
		return
	}
	assembler.scripts = scripts
}

// BindExecutors attaches only Go-owned, redacted Executor runtime state. It
// never treats a persisted plugin_state or old Node snapshot as process
// ownership evidence.
func (assembler *Assembler) BindExecutors(executors *applicationexecutors.Service) {
	if assembler == nil {
		return
	}
	assembler.executors = executors
}

// BindOperations adds the Go-owned long-running operation projection after
// the service graph is assembled. Only bounded lifecycle metadata is exposed;
// prompts, process output and filesystem capabilities never enter snapshots.
func (assembler *Assembler) BindOperations(operations *applicationoperations.Service) {
	if assembler == nil {
		return
	}
	assembler.operations = operations
}

// BindMCPRuntime overlays the transport's live, redacted status on persisted
// configuration. The callback has no token or lifecycle mutation capability.
func (assembler *Assembler) BindMCPRuntime(runtime func() map[string]any) {
	if assembler == nil {
		return
	}
	assembler.mcpRuntime = runtime
}

func DirectReader(store repository.ReadOnly) ReadSession {
	return func(ctx context.Context, operation func(QueryStore) error) error {
		if store == nil || operation == nil {
			return domainproject.ErrUnavailable
		}
		if err := store.Check(ctx); err != nil {
			return err
		}
		return operation(store)
	}
}

// TransactionalReader always begins after the caller's mutation transaction
// has returned successfully, so response data is reloaded from committed rows.
func TransactionalReader(store repository.Transactional) ReadSession {
	return func(ctx context.Context, operation func(QueryStore) error) error {
		if store == nil || operation == nil {
			return domainproject.ErrUnavailable
		}
		return store.Transact(ctx, func(transaction repository.WriteTransaction) error {
			return operation(transaction)
		})
	}
}

func TransactionalIntakeReader(store repository.IntakeTransactional) ReadSession {
	return func(ctx context.Context, operation func(QueryStore) error) error {
		if store == nil || operation == nil {
			return domainproject.ErrUnavailable
		}
		return store.TransactIntake(ctx, func(transaction repository.IntakeWriteTransaction) error {
			return operation(transaction)
		})
	}
}

// TransactionalPlanReader is selected when the P07 owner is available. It
// provides project, intake, and plan projections from one controlled reader
// transaction after a successful plan mutation has committed.
func TransactionalPlanReader(store repository.PlanTransactional) ReadSession {
	return func(ctx context.Context, operation func(QueryStore) error) error {
		if store == nil || operation == nil {
			return domainproject.ErrUnavailable
		}
		return store.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
			return operation(transaction)
		})
	}
}

// TransactionalChatReader provides a committed view after P003 chat/config
// mutations. It retains the same narrow QueryStore boundary as other readers.
func TransactionalChatReader(store repository.ChatTransactional) ReadSession {
	return func(ctx context.Context, operation func(QueryStore) error) error {
		if store == nil || operation == nil {
			return domainproject.ErrUnavailable
		}
		return store.TransactChat(ctx, func(transaction repository.ChatWriteTransaction) error {
			return operation(transaction)
		})
	}
}

func (assembler *Assembler) List(ctx context.Context, visibility domainproject.Visibility) ([]contracts.Project, error) {
	var result []contracts.Project
	err := assembler.withStore(ctx, func(store QueryStore) error {
		var err error
		result, err = listProjects(ctx, store, visibility)
		return err
	})
	return result, err
}

func (assembler *Assembler) Get(ctx context.Context, projectID int64, visibility domainproject.Visibility) (contracts.Project, error) {
	var result contracts.Project
	err := assembler.withStore(ctx, func(store QueryStore) error {
		var err error
		result, err = getProject(ctx, store, projectID, visibility, true)
		return err
	})
	return result, err
}

func (assembler *Assembler) Assemble(
	ctx context.Context,
	projectID *int64,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	var result contracts.AppSnapshot
	err := assembler.withStore(ctx, func(store QueryStore) error {
		projects, err := listProjects(ctx, store, visibility)
		if err != nil {
			return err
		}
		mcp, err := mcpSnapshot(ctx, store, assembler.mcpRuntime)
		if err != nil {
			return err
		}
		result = emptySnapshot(projects, mcp)
		if projectID == nil {
			return validateSnapshot(result)
		}
		if *projectID <= 0 {
			return domainproject.ErrNotFound
		}
		record, exists, err := store.GetProject(ctx, *projectID)
		if err != nil {
			return err
		}
		if !exists {
			return domainproject.ErrNotFound
		}
		active, err := projectContract(record, nil, visibility)
		if err != nil {
			return err
		}
		stateRecord, stateExists, err := store.GetProjectState(ctx, record.ID)
		if err != nil {
			return err
		}
		state, err := stateSnapshot(record, stateRecord, stateExists, visibility)
		if err != nil {
			return err
		}
		id := record.ID
		result.ActiveProjectID = &id
		result.ActiveProject = &active
		result.State = &state
		planRecords := map[int64]domainplan.Plan(nil)
		if planStore, ok := store.(repository.PlanQueries); ok {
			loadedPlans, plans, tasks, events, loadErr := planSnapshotRows(ctx, planStore, record.ID)
			if loadErr != nil {
				return loadErr
			}
			planRecords = loadedPlans
			result.Plans, result.Tasks, result.Events = plans, tasks, events
		}
		if intakeStore, ok := store.(repository.IntakeQueries); ok {
			requirements, loadErr := intakeSnapshots(ctx, intakeStore, record.ID, domainintake.Requirement, planRecords)
			if loadErr != nil {
				return loadErr
			}
			feedback, loadErr := intakeSnapshots(ctx, intakeStore, record.ID, domainintake.Feedback, planRecords)
			if loadErr != nil {
				return loadErr
			}
			result.Requirements, result.Feedback = requirements, feedback
		}
		if automationStore, ok := store.(repository.AutomationQueries); ok {
			scripts, executors, loadErr := automationSnapshots(ctx, automationStore, record.ID, assembler.scripts, assembler.executors)
			if loadErr != nil {
				return loadErr
			}
			result.Scripts, result.Executors = scripts, executors
		}
		return validateSnapshot(result)
	})
	if err != nil || projectID == nil || result.ActiveProjectID == nil {
		return result, err
	}
	if assembler.operations != nil && assembler.operations.Configured() {
		operations, operationErr := assembler.operations.ListForSnapshot(ctx, *result.ActiveProjectID, 20)
		if operationErr != nil {
			return contracts.AppSnapshot{}, operationErr
		}
		if operationErr = applyOperationSnapshots(&result, operations); operationErr != nil {
			return contracts.AppSnapshot{}, operationErr
		}
	}
	if assembler.attachments != nil {
		attachments, attachmentErr := assembler.attachments.ListAttachmentSnapshots(ctx, *result.ActiveProjectID)
		if attachmentErr != nil {
			return contracts.AppSnapshot{}, attachmentErr
		}
		result.Attachments, attachmentErr = attachmentSnapshots(attachments)
		if attachmentErr != nil {
			return contracts.AppSnapshot{}, attachmentErr
		}
	}
	return result, validateSnapshot(result)
}

func applyOperationSnapshots(snapshot *contracts.AppSnapshot, operations []domainoperation.Operation) error {
	if snapshot == nil {
		return domainproject.ErrInvalidRecord
	}
	active := make([]contracts.SanitizedObject, 0)
	var last *contracts.SanitizedObject
	for _, operation := range operations {
		mapped, err := operationSnapshot(operation)
		if err != nil {
			return err
		}
		if operation.Status == domainoperation.StatusQueued || operation.Status == domainoperation.StatusRunning {
			active = append(active, mapped)
			continue
		}
		if last == nil && operation.Status.Terminal() {
			copy := mapped
			last = &copy
		}
	}
	snapshot.ActiveOperations = active
	if len(active) > 0 {
		copy := active[0]
		snapshot.ActiveOperation = &copy
	} else {
		snapshot.ActiveOperation = nil
	}
	snapshot.LastOperation = last
	return nil
}

type operationResultCounts struct {
	PendingIntakes int `json:"pending_intakes"`
	GeneratedPlans int `json:"generated_plans"`
	ProcessedPlans int `json:"processed_plans"`
}

func operationSnapshot(operation domainoperation.Operation) (contracts.SanitizedObject, error) {
	activity := make([]map[string]any, 0, 3)
	logLines := make([]string, 0, 3)
	appendLine := func(at, text string) {
		if strings.TrimSpace(at) == "" || strings.TrimSpace(text) == "" {
			return
		}
		activity = append(activity, map[string]any{"role": "system", "text": text, "at": at})
		logLines = append(logLines, text)
	}
	appendLine(operation.CreatedAt, "任务已进入 Go 运行队列")
	if operation.StartedAt != nil {
		appendLine(*operation.StartedAt, "Agent CLI 已启动")
	}
	if operation.FinishedAt != nil {
		appendLine(*operation.FinishedAt, operationTerminalText(operation))
	}
	var exitCode any
	if operation.Status == domainoperation.StatusSucceeded {
		exitCode = 0
	} else if operation.Status == domainoperation.StatusFailed || operation.Status == domainoperation.StatusInterrupted {
		exitCode = 1
	}
	cancelled := operation.Status == domainoperation.StatusCancelled
	var cancelledAt *string
	if cancelled {
		cancelledAt = operation.FinishedAt
	}
	return sanitizedObject(map[string]any{
		"label": operationLabel(operation.Type), "operationId": operation.OperationID,
		"runtimeOwner": "go", "projectId": operation.ProjectID, "planId": nil, "taskId": nil,
		"operationType": operation.Type, "startedAt": operation.StartedAt, "finishedAt": operation.FinishedAt,
		"exitCode": exitCode, "cancelled": cancelled, "cancelledAt": cancelledAt,
		"logTail": strings.Join(logLines, "\n"), "activity": activity,
	})
}

func operationLabel(operationType string) string {
	switch operationType {
	case "loop.start":
		return "启动工作循环"
	case "loop.stop":
		return "停止工作循环"
	case "loop.run_once":
		return "执行工作循环"
	case "script.run":
		return "执行脚本"
	case "executor.run", "executor.action":
		return "执行器运行"
	default:
		return operationType
	}
}

func operationTerminalText(operation domainoperation.Operation) string {
	switch operation.Status {
	case domainoperation.StatusSucceeded:
		counts := operationResultCounts{}
		if operation.Result != nil {
			_ = json.Unmarshal(*operation.Result, &counts)
		}
		if counts.GeneratedPlans > 0 || counts.ProcessedPlans > 0 {
			return "本轮完成：生成计划 " + strconv.Itoa(counts.GeneratedPlans) + "，执行任务 " + strconv.Itoa(counts.ProcessedPlans)
		}
		return "本轮执行成功"
	case domainoperation.StatusFailed:
		if operation.Error != nil {
			return "本轮执行失败（" + operation.Error.Code + "）"
		}
		return "本轮执行失败"
	case domainoperation.StatusCancelled:
		return "本轮执行已取消"
	case domainoperation.StatusInterrupted:
		return "本轮执行被中断"
	default:
		return ""
	}
}

func automationSnapshots(
	ctx context.Context,
	store repository.AutomationQueries,
	projectID int64,
	runtime *applicationscripts.Service,
	executorRuntime *applicationexecutors.Service,
) ([]contracts.SanitizedObject, []contracts.SanitizedObject, error) {
	const pageSize = 200
	scripts := make([]contracts.SanitizedObject, 0)
	for offset := 0; ; offset += pageSize {
		page, err := store.ListScripts(ctx, domainautomation.ListOptions{ProjectID: projectID, Limit: pageSize, Offset: offset})
		if err != nil {
			return nil, nil, err
		}
		for _, record := range page {
			mapped, mapErr := scriptSnapshot(record, runtime)
			if mapErr != nil {
				return nil, nil, mapErr
			}
			scripts = append(scripts, mapped)
		}
		if len(page) < pageSize {
			break
		}
	}
	executors := make([]contracts.SanitizedObject, 0)
	for offset := 0; ; offset += pageSize {
		page, err := store.ListExecutors(ctx, domainautomation.ListOptions{ProjectID: projectID, Limit: pageSize, Offset: offset})
		if err != nil {
			return nil, nil, err
		}
		for _, record := range page {
			mapped, mapErr := executorSnapshot(record, executorRuntime)
			if mapErr != nil {
				return nil, nil, mapErr
			}
			executors = append(executors, mapped)
		}
		if len(page) < pageSize {
			break
		}
	}
	return scripts, executors, nil
}

func scriptSnapshot(value domainautomation.Script, runtime *applicationscripts.Service) (contracts.SanitizedObject, error) {
	projectID := int64(0)
	if value.ProjectID != nil {
		projectID = *value.ProjectID
	}
	enabled, failAborts := 0, 0
	if value.Enabled {
		enabled = 1
	}
	if value.FailAborts {
		failAborts = 1
	}
	fields := map[string]any{
		"id": value.ID, "project_id": projectID, "name": value.Name,
		"path": "", "runtime": value.Runtime, "body": "", "description": value.Description,
		"trigger_mode": value.TriggerMode, "hook_stage": copyOptionalString(value.HookStage),
		"schedule_cron": copyOptionalString(value.ScheduleCron), "enabled": enabled, "work_dir": "",
		"timeout_seconds": value.TimeoutSeconds, "fail_aborts": failAborts, "context_inject": value.ContextInject,
		"sort_order": value.SortOrder, "last_status": copyOptionalString(value.LastStatus),
		"last_exit_code": copyOptionalInt64(value.LastExitCode), "last_duration_ms": copyOptionalInt64(value.LastDurationMS),
		"last_log": copyOptionalString(value.LastLog), "last_run_at": copyOptionalString(value.LastRunAt), "created_at": value.CreatedAt,
		"updated_at": value.UpdatedAt, "source_type": value.SourceType,
		"running": false, "runStatus": scriptRunStatus(value.LastStatus), "activeOperation": nil,
	}
	if runtime != nil {
		if live, found := runtime.ScriptRuntime(projectID, value.ID); found {
			if live.LastStatus != nil {
				fields["last_status"] = copyOptionalString(live.LastStatus)
			}
			if live.LastExitCode != nil {
				fields["last_exit_code"] = copyOptionalInt64(live.LastExitCode)
			}
			if live.LastDurationMS != nil {
				fields["last_duration_ms"] = copyOptionalInt64(live.LastDurationMS)
			}
			if live.LastRunAt != nil {
				fields["last_run_at"] = copyOptionalString(live.LastRunAt)
			}
			fields["running"] = live.Running
			if live.Running {
				fields["runStatus"] = "running"
				fields["activeOperation"] = map[string]any{"operation_id": live.OperationID, "status": live.OperationStatus}
			} else if live.LastStatus != nil {
				fields["runStatus"] = *live.LastStatus
			}
		}
	}
	return sanitizedObject(fields)
}

func scriptRunStatus(status *string) string {
	if status == nil || strings.TrimSpace(*status) == "" {
		return "idle"
	}
	return *status
}

func executorSnapshot(value domainautomation.Executor, runtime *applicationexecutors.Service) (contracts.SanitizedObject, error) {
	enabled, groupDefault := false, false
	enabled = value.Enabled
	groupDefault = value.GroupIsDefault
	fields := map[string]any{
		"id": value.ID, "project_id": value.ProjectID, "label": value.Label, "type": value.Type,
		"command": "", "args": []any{}, "has_command": value.Command != "", "argument_count": jsonArrayLength(value.ArgsJSON),
		"group_kind": copyOptionalString(value.GroupKind), "group_is_default": groupDefault,
		"depends_order": value.DependsOrder, "enabled": enabled, "sort_order": value.SortOrder,
		"last_status": copyOptionalString(value.LastStatus), "last_exit_code": copyOptionalInt64(value.LastExitCode),
		"last_duration_ms": copyOptionalInt64(value.LastDurationMS), "last_log": copyOptionalString(value.LastLog),
		"last_run_at": copyOptionalString(value.LastRunAt), "created_at": value.CreatedAt, "updated_at": value.UpdatedAt,
		"running": false, "runStatus": executorRunStatus(value.LastStatus), "activeOperation": nil,
		"plugin_state": nil,
	}
	if runtime != nil {
		if live, found := runtime.ExecutorRuntime(value.ProjectID, value.ID); found {
			if live.LastStatus != nil {
				fields["last_status"] = copyOptionalString(live.LastStatus)
			}
			if live.LastExitCode != nil {
				fields["last_exit_code"] = copyOptionalInt64(live.LastExitCode)
			}
			if live.LastDurationMS != nil {
				fields["last_duration_ms"] = copyOptionalInt64(live.LastDurationMS)
			}
			if live.LastRunAt != nil {
				fields["last_run_at"] = copyOptionalString(live.LastRunAt)
			}
			fields["running"] = live.Running
			if live.Running {
				fields["runStatus"] = "running"
				fields["activeOperation"] = map[string]any{"operation_id": live.OperationID, "status": live.OperationStatus}
			} else if live.LastStatus != nil {
				fields["runStatus"] = *live.LastStatus
			}
			if value.Type == "plugin" {
				fields["plugin_state"] = map[string]any{"running": live.PluginRunning, "last_action": nullableText(live.PluginAction)}
			}
		}
	}
	return sanitizedObject(fields)
}

func executorRunStatus(status *string) string {
	if status == nil || strings.TrimSpace(*status) == "" {
		return "idle"
	}
	return *status
}

func jsonArrayLength(value json.RawMessage) int {
	var entries []json.RawMessage
	if json.Unmarshal(value, &entries) != nil {
		return 0
	}
	return len(entries)
}

func planSnapshotRows(
	ctx context.Context,
	store repository.PlanQueries,
	projectID int64,
) (map[int64]domainplan.Plan, []contracts.SanitizedObject, []contracts.SanitizedObject, []contracts.SanitizedObject, error) {
	const pageSize = 200
	plans := make([]domainplan.Plan, 0)
	for offset := 0; ; offset += pageSize {
		page, err := store.ListPlans(ctx, domainplan.ListOptions{ProjectID: projectID, Limit: pageSize, Offset: offset})
		if err != nil {
			return nil, nil, nil, nil, err
		}
		plans = append(plans, page...)
		if len(page) < pageSize {
			break
		}
	}
	planSnapshots := make([]contracts.SanitizedObject, 0, len(plans))
	taskSnapshots := make([]contracts.SanitizedObject, 0)
	planByID := make(map[int64]domainplan.Plan, len(plans))
	for _, plan := range plans {
		mappedPlan, err := applicationplans.PlanSnapshot(plan)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		planSnapshots = append(planSnapshots, mappedPlan)
		planByID[plan.ID] = plan
		tasks, err := store.ListPlanTasks(ctx, projectID, plan.ID)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		for _, task := range tasks {
			mappedTask, mapErr := applicationplans.TaskSnapshot(task, plan)
			if mapErr != nil {
				return nil, nil, nil, nil, mapErr
			}
			taskSnapshots = append(taskSnapshots, mappedTask)
		}
	}
	events, err := store.ListEvents(ctx, domainevent.ListOptions{ProjectID: projectID, Limit: 80, Offset: 0})
	if err != nil {
		return nil, nil, nil, nil, err
	}
	eventSnapshots := make([]contracts.SanitizedObject, 0, len(events))
	for _, event := range events {
		mapped, mapErr := applicationevents.EventSnapshot(event)
		if mapErr != nil {
			return nil, nil, nil, nil, mapErr
		}
		eventSnapshots = append(eventSnapshots, mapped)
	}
	return planByID, planSnapshots, taskSnapshots, eventSnapshots, nil
}

func intakeSnapshots(
	ctx context.Context,
	store repository.IntakeQueries,
	projectID int64,
	intakeType domainintake.Type,
	plans map[int64]domainplan.Plan,
) ([]contracts.SanitizedObject, error) {
	const pageSize = 200
	records := make([]domainintake.Intake, 0)
	for offset := 0; ; offset += pageSize {
		page, err := store.ListIntakes(ctx, domainintake.ListOptions{
			ProjectID: projectID, Type: intakeType, Limit: pageSize, Offset: offset,
		})
		if err != nil {
			return nil, err
		}
		records = append(records, page...)
		if len(page) < pageSize {
			break
		}
	}
	result := make([]contracts.SanitizedObject, 0, len(records))
	for _, record := range records {
		links, err := store.ListPlanLinksForIntake(ctx, projectID, intakeType, record.ID)
		if err != nil {
			return nil, err
		}
		mapped, err := intakeSnapshot(record, links, plans)
		if err != nil {
			return nil, err
		}
		result = append(result, mapped)
	}
	return result, nil
}

func intakeSnapshot(value domainintake.Intake, links []domainintake.PlanLink, plans map[int64]domainplan.Plan) (contracts.SanitizedObject, error) {
	createdAt, err := utcTimestamp(value.CreatedAt)
	if err != nil {
		return nil, err
	}
	updatedAt, err := utcTimestamp(value.UpdatedAt)
	if err != nil {
		return nil, err
	}
	acceptedAt, err := optionalUTCTimestamp(value.AcceptedAt)
	if err != nil {
		return nil, err
	}
	lastFailedAt, err := optionalUTCTimestamp(value.Failure.LastFailedAt)
	if err != nil {
		return nil, err
	}
	linked := make([]any, 0, len(links))
	currentPlanID := currentPlanLinkID(links, plans)
	for _, link := range links {
		var linkID any
		if link.ID > 0 {
			linkID = link.ID
		}
		plan, exists := plans[link.PlanID]
		filePath, title := "", ""
		var status any
		var completed, total any
		var validation any
		if exists {
			planDTO := applicationplans.PlanDTOFromDomain(plan)
			filePath, title = planDTO.FilePath, planDTO.Title
			status, completed, total = string(plan.Status), plan.CompletedTasks, plan.TotalTasks
			if plan.ValidationPassed {
				validation = 1
			} else {
				validation = 0
			}
		}
		if title == "" {
			title = strings.TrimSpace(link.PhaseTitle)
		}
		if title == "" {
			title = "Plan #" + strconv.FormatInt(link.PlanID, 10)
		}
		linked = append(linked, map[string]any{
			"link_id": linkID, "intake_type": link.IntakeType, "intake_id": link.IntakeID,
			"plan_id": link.PlanID, "phase_index": link.PhaseIndex,
			"phase_title": nullableText(link.PhaseTitle), "is_current": currentPlanID == link.PlanID,
			"title": title, "file_path": nullableText(filePath), "status": status,
			"completed_tasks": completed, "total_tasks": total, "validation_passed": validation,
		})
	}
	fields := map[string]any{
		"id": value.ID, "project_id": value.ProjectID,
		"title": value.Title, "body": value.Body, "status": value.Status,
		"agent_cli_provider": value.AgentCLI.Provider, "agent_cli_command": value.AgentCLI.Command,
		"codex_reasoning_effort":                 value.AgentCLI.CodexReasoningEffort,
		"plan_generation_strategy":               value.PlanGeneration.Strategy,
		"plan_generation_provider":               value.PlanGeneration.Provider,
		"plan_generation_command":                value.PlanGeneration.Command,
		"plan_generation_model":                  value.PlanGeneration.Model,
		"plan_generation_codex_reasoning_effort": value.PlanGeneration.CodexReasoningEffort,
		"plan_generation_claude_base_url":        safeBaseURL(value.PlanGeneration.ClaudeBaseURL),
		"plan_generation_claude_auth_token":      maskToken(value.PlanGeneration.ClaudeAuthToken),
		"plan_generation_claude_model":           value.PlanGeneration.ClaudeModel,
		"plan_generation_claude_config_id":       value.PlanGeneration.ClaudeConfigID,
		"plan_generation_has_claude_auth_token":  value.PlanGeneration.ClaudeAuthToken != "",
		"generate_fail_count":                    value.Failure.Count, "last_generate_fail_at": lastFailedAt,
		"last_generate_error":                  redactedError(value.Failure.LastError),
		"last_generate_agent_cli_provider":     value.Failure.LastAgentCLIProvider,
		"last_generate_codex_reasoning_effort": value.Failure.LastCodexEffort,
		"linked_plan_id":                       value.LinkedPlanID, "linked_plans": linked,
		"created_at": createdAt, "updated_at": updatedAt, "accepted_at": acceptedAt,
	}
	if value.Type == domainintake.Feedback {
		fields["requirement_id"] = value.RequirementID
	}
	return sanitizedObject(fields)
}

func attachmentSnapshots(values []AttachmentSnapshot) ([]contracts.SanitizedObject, error) {
	result := make([]contracts.SanitizedObject, 0, len(values))
	for _, value := range values {
		if value.ID <= 0 || value.DisplayName == "" || value.Size < 0 || value.MIMEType == "" ||
			!strings.HasPrefix(value.DownloadURL, "/api/") {
			return nil, domainproject.ErrInvalidRecord
		}
		mapped, err := sanitizedObject(map[string]any{
			"id": value.ID, "display_name": value.DisplayName, "size": value.Size,
			"mime_type": value.MIMEType, "download_url": value.DownloadURL,
		})
		if err != nil {
			return nil, err
		}
		result = append(result, mapped)
	}
	return result, nil
}

func optionalUTCTimestamp(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	normalized, err := utcTimestamp(*value)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func currentPlanLinkID(links []domainintake.PlanLink, plans map[int64]domainplan.Plan) int64 {
	if len(links) == 0 {
		return 0
	}
	for _, link := range links {
		if plan, exists := plans[link.PlanID]; exists && plan.Status != domainplan.StatusCompleted &&
			plan.Status != domainplan.StatusInterrupted && plan.Status != domainplan.StatusDraft {
			return link.PlanID
		}
	}
	for _, link := range links {
		if plan, exists := plans[link.PlanID]; !exists || plan.Status != domainplan.StatusCompleted {
			return link.PlanID
		}
	}
	return links[0].PlanID
}

func (assembler *Assembler) withStore(ctx context.Context, operation func(QueryStore) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if assembler == nil || assembler.read == nil || operation == nil {
		return domainproject.ErrUnavailable
	}
	return assembler.read(ctx, operation)
}

func listProjects(ctx context.Context, store QueryStore, visibility domainproject.Visibility) ([]contracts.Project, error) {
	records, err := store.ListProjects(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]contracts.Project, 0, len(records))
	for _, record := range records {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		state, exists, err := store.GetProjectState(ctx, record.ID)
		if err != nil {
			return nil, err
		}
		project, err := projectContract(record, stateOrDefault(record, state, exists), visibility)
		if err != nil {
			return nil, err
		}
		result = append(result, project)
	}
	sortProjects(result)
	return result, nil
}

func getProject(
	ctx context.Context,
	store QueryStore,
	projectID int64,
	visibility domainproject.Visibility,
	withSummary bool,
) (contracts.Project, error) {
	if projectID <= 0 {
		return contracts.Project{}, domainproject.ErrNotFound
	}
	record, exists, err := store.GetProject(ctx, projectID)
	if err != nil {
		return contracts.Project{}, err
	}
	if !exists {
		return contracts.Project{}, domainproject.ErrNotFound
	}
	if !withSummary {
		return projectContract(record, nil, visibility)
	}
	state, stateExists, err := store.GetProjectState(ctx, projectID)
	if err != nil {
		return contracts.Project{}, err
	}
	return projectContract(record, stateOrDefault(record, state, stateExists), visibility)
}

func projectContract(record repository.Project, state *repository.ProjectState, visibility domainproject.Visibility) (contracts.Project, error) {
	createdAt, err := utcTimestamp(record.CreatedAt)
	if err != nil {
		return contracts.Project{}, domainproject.ErrInvalidRecord
	}
	updatedAt, err := utcTimestamp(record.UpdatedAt)
	if err != nil {
		return contracts.Project{}, domainproject.ErrInvalidRecord
	}
	workspace := ""
	if visibility.WorkspacePath {
		workspace = record.WorkspacePath
	}
	result := contracts.Project{
		ID: record.ID, Name: record.Name, WorkspacePath: workspace,
		Description: record.Description, CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if state != nil {
		running := int(state.Running)
		phase := normalizedPhase(state.Phase)
		interval := int(state.IntervalSeconds)
		validationCommand, projectPrompt := state.ValidationCommand, state.ProjectPrompt
		provider, command := normalizedProvider(state.AgentCLIProvider), state.AgentCLICommand
		result.Running, result.Phase, result.IntervalSeconds = &running, &phase, &interval
		result.ValidationCommand, result.ProjectPrompt = &validationCommand, &projectPrompt
		result.AgentCLIProvider, result.AgentCLICommand = &provider, &command
		result.CodexReasoningEffort = copyOptionalString(state.CodexReasoningEffort)
		generationStrategy, generationCommand, generationModel := state.PlanGenerationStrategy, state.PlanGenerationCommand, state.PlanGenerationModel
		generationBaseURL, generationClaudeModel := safeBaseURL(state.PlanGenerationClaudeBaseURL), state.PlanGenerationClaudeModel
		generationHasToken, generationConfigID := state.PlanGenerationClaudeAuthToken != "", state.PlanGenerationClaudeConfigID
		result.PlanGenerationStrategy, result.PlanGenerationProvider = &generationStrategy, copyOptionalString(state.PlanGenerationProvider)
		result.PlanGenerationCommand, result.PlanGenerationModel = &generationCommand, &generationModel
		result.PlanGenerationCodexReasoningEffort = copyOptionalString(state.PlanGenerationCodexReasoningEffort)
		result.PlanGenerationClaudeBaseURL, result.PlanGenerationClaudeModel = &generationBaseURL, &generationClaudeModel
		result.PlanGenerationHasClaudeAuthToken, result.PlanGenerationClaudeConfigID = &generationHasToken, &generationConfigID
		executionStrategy, executionCommand, executionModel := state.PlanExecutionStrategy, state.PlanExecutionCommand, state.PlanExecutionModel
		executionBaseURL, executionClaudeModel := safeBaseURL(state.PlanExecutionClaudeBaseURL), state.PlanExecutionClaudeModel
		executionHasToken, executionConfigID := state.PlanExecutionClaudeAuthToken != "", state.PlanExecutionClaudeConfigID
		result.PlanExecutionStrategy, result.PlanExecutionProvider = &executionStrategy, copyOptionalString(state.PlanExecutionProvider)
		result.PlanExecutionCommand, result.PlanExecutionModel = &executionCommand, &executionModel
		result.PlanExecutionCodexReasoningEffort = copyOptionalString(state.PlanExecutionCodexReasoningEffort)
		result.PlanExecutionClaudeBaseURL, result.PlanExecutionClaudeModel = &executionBaseURL, &executionClaudeModel
		result.PlanExecutionHasClaudeAuthToken, result.PlanExecutionClaudeConfigID = &executionHasToken, &executionConfigID
	}
	if result.Validate() != nil {
		return contracts.Project{}, domainproject.ErrInvalidRecord
	}
	return result, nil
}

func stateOrDefault(project repository.Project, state repository.ProjectState, exists bool) *repository.ProjectState {
	if exists {
		copy := state
		copy.Phase = normalizedPhase(copy.Phase)
		copy.AgentCLIProvider = normalizedProvider(copy.AgentCLIProvider)
		return &copy
	}
	return &repository.ProjectState{
		ProjectID: project.ID, Running: 0, Phase: "idle", IntervalSeconds: 5,
		AgentCLIProvider: "codex", PlanGenerationStrategy: "external-cli-markdown",
		PlanExecutionStrategy: "external-cli", UpdatedAt: project.UpdatedAt,
	}
}

func stateSnapshot(
	project repository.Project,
	state repository.ProjectState,
	exists bool,
	visibility domainproject.Visibility,
) (contracts.SanitizedObject, error) {
	value := stateOrDefault(project, state, exists)
	updatedAt, err := utcTimestamp(value.UpdatedAt)
	if err != nil {
		return nil, domainproject.ErrInvalidRecord
	}
	workspace := ""
	if visibility.WorkspacePath {
		workspace = project.WorkspacePath
	}
	environment := value.EnvVars
	if environment != "" {
		environment = domainproject.RedactedEnvironment
	}
	fields := map[string]any{
		"project_id": value.ProjectID, "running": value.Running, "phase": normalizedPhase(value.Phase),
		"interval_seconds": value.IntervalSeconds, "validation_command": value.ValidationCommand,
		"project_prompt": value.ProjectPrompt, "agent_cli_provider": normalizedProvider(value.AgentCLIProvider),
		"agent_cli_command": value.AgentCLICommand, "codex_reasoning_effort": value.CodexReasoningEffort,
		"plan_generation_strategy": value.PlanGenerationStrategy, "plan_generation_provider": value.PlanGenerationProvider,
		"plan_generation_command": value.PlanGenerationCommand, "plan_generation_model": value.PlanGenerationModel,
		"plan_generation_codex_reasoning_effort": value.PlanGenerationCodexReasoningEffort,
		"plan_generation_claude_base_url":        safeBaseURL(value.PlanGenerationClaudeBaseURL),
		"plan_generation_claude_auth_token":      maskToken(value.PlanGenerationClaudeAuthToken),
		"plan_generation_claude_model":           value.PlanGenerationClaudeModel,
		"plan_generation_has_claude_auth_token":  value.PlanGenerationClaudeAuthToken != "",
		"plan_generation_claude_config_id":       value.PlanGenerationClaudeConfigID,
		"plan_execution_strategy":                value.PlanExecutionStrategy, "plan_execution_provider": value.PlanExecutionProvider,
		"plan_execution_command": value.PlanExecutionCommand, "plan_execution_model": value.PlanExecutionModel,
		"plan_execution_codex_reasoning_effort": value.PlanExecutionCodexReasoningEffort,
		"plan_execution_claude_base_url":        safeBaseURL(value.PlanExecutionClaudeBaseURL),
		"plan_execution_claude_auth_token":      maskToken(value.PlanExecutionClaudeAuthToken),
		"plan_execution_claude_model":           value.PlanExecutionClaudeModel,
		"plan_execution_has_claude_auth_token":  value.PlanExecutionClaudeAuthToken != "",
		"plan_execution_claude_config_id":       value.PlanExecutionClaudeConfigID,
		"last_issue_hash":                       value.LastIssueHash, "last_error": redactedError(value.LastError),
		"env_vars": environment, "updated_at": updatedAt, "workspace_path": workspace,
	}
	if value.Version > 0 {
		fields["version"] = value.Version
	}
	return sanitizedObject(fields)
}

func mcpSnapshot(ctx context.Context, store QueryStore, runtime func() map[string]any) (contracts.SanitizedObject, error) {
	if runtime != nil {
		return sanitizedObject(runtime())
	}
	settings, err := store.ListSettings(ctx, "mcp.")
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, len(settings))
	for _, setting := range settings {
		values[setting.Key] = setting.Value
	}
	settingValue := func(key, environment string) string {
		if value, exists := os.LookupEnv(environment); exists {
			return value
		}
		return values[key]
	}
	enabled := booleanSetting(settingValue("mcp.enabled", "AUTOPLAN_MCP_ENABLED"), true)
	transport := strings.ToLower(strings.TrimSpace(settingValue("mcp.transport", "AUTOPLAN_MCP_TRANSPORT")))
	if transport != "stdio" {
		transport = domainproject.DefaultMCPTransport
	}
	host := strings.ToLower(strings.TrimSpace(settingValue("mcp.host", "AUTOPLAN_MCP_HOST")))
	if host == "" || (host != "localhost" && net.ParseIP(host) == nil) ||
		(host != "localhost" && !net.ParseIP(host).IsLoopback()) {
		host = domainproject.DefaultMCPHost
	}
	port := domainproject.DefaultMCPPort
	if parsed, parseErr := strconv.ParseInt(settingValue("mcp.port", "AUTOPLAN_MCP_PORT"), 10, 64); parseErr == nil && parsed > 0 && parsed <= 65535 {
		port = parsed
	}
	mcpPath := normalizeMCPPath(settingValue("mcp.path", "AUTOPLAN_MCP_PATH"))
	token := strings.TrimSpace(settingValue("mcp.authToken", "AUTOPLAN_MCP_AUTH_TOKEN"))
	status := "unavailable"
	if !enabled {
		status = "disabled"
	}
	connection := "npm run mcp:stdio"
	var httpHost any
	var httpPort any
	var address any
	if transport == "http" {
		connection = "http://" + net.JoinHostPort(host, strconv.FormatInt(port, 10)) + mcpPath
		httpHost, httpPort, address = host, port, connection
	}
	return sanitizedObject(map[string]any{
		"enabled": enabled, "running": false, "status": status, "transport": transport,
		"host": httpHost, "port": httpPort, "url": address,
		"hasAuthToken": token != "", "authTokenMasked": maskToken(token),
		"authHeader": "Authorization: Bearer <token>", "localOnly": true,
		"tools": mcpToolNames(), "toolDocs": []any{}, "connectionExample": connection,
		"note": mcpNote(transport), "lastEvent": nil, "lastError": nil, "startedAt": nil,
	})
}

func emptySnapshot(projects []contracts.Project, mcp contracts.SanitizedObject) contracts.AppSnapshot {
	empty := func() []contracts.SanitizedObject { return make([]contracts.SanitizedObject, 0) }
	return contracts.AppSnapshot{
		ActiveProjectID: nil, ActiveProject: nil, Projects: projects, MCP: mcp, State: nil,
		Requirements: empty(), Feedback: empty(), Attachments: empty(), Plans: empty(), Tasks: empty(),
		Events: empty(), Scans: empty(), ScanSummary: mustSanitizedObject(map[string]any{
			"count": 0, "total_size": 0, "latest_scanned_at": nil, "latest_modified_at": nil,
		}),
		Scripts: empty(), Executors: empty(), Terminals: empty(), ActiveOperation: nil,
		ActiveOperations: empty(), LastOperation: nil,
	}
}

func validateSnapshot(value contracts.AppSnapshot) error {
	if value.Validate() != nil {
		return domainproject.ErrInvalidRecord
	}
	return nil
}

func sanitizedObject(fields map[string]any) (contracts.SanitizedObject, error) {
	result := make(contracts.SanitizedObject, len(fields))
	for name, value := range fields {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, domainproject.ErrInvalidRecord
		}
		result[name] = encoded
	}
	if result.Validate() != nil {
		return nil, domainproject.ErrInvalidRecord
	}
	return result, nil
}

func mustSanitizedObject(fields map[string]any) contracts.SanitizedObject {
	result, err := sanitizedObject(fields)
	if err != nil {
		panic("static sanitized object is invalid")
	}
	return result
}

func booleanSetting(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "on", "enabled":
		return true
	case "0", "false", "off", "disabled":
		return false
	default:
		return fallback
	}
}

func normalizedProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "claude", "opencode", "oh-my-pi":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "codex"
	}
}

func normalizedPhase(value string) string {
	phase := strings.TrimSpace(value)
	if phase == "" {
		return "idle"
	}
	return phase
}

func maskToken(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) == 0 {
		return ""
	}
	if len(runes) <= 4 {
		return "····"
	}
	return "····" + string(runes[len(runes)-4:])
}

func copyOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyOptionalInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func safeBaseURL(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	parsed.User, parsed.RawQuery, parsed.Fragment, parsed.RawFragment = nil, "", "", ""
	parsed.ForceQuery = false
	return parsed.String()
}

func redactedError(value *string) *string {
	if value == nil {
		return nil
	}
	redacted := "<redacted_error>"
	return &redacted
}

func utcTimestamp(value string) (string, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", err
	}
	return parsed.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}

func sortProjects(projects []contracts.Project) {
	for left := 1; left < len(projects); left++ {
		for right := left; right > 0; right-- {
			current, previous := projects[right], projects[right-1]
			if current.UpdatedAt < previous.UpdatedAt || (current.UpdatedAt == previous.UpdatedAt && current.ID < previous.ID) {
				break
			}
			projects[right], projects[right-1] = projects[right-1], projects[right]
		}
	}
}

func normalizeMCPPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "/mcp"
	}
	if !strings.HasPrefix(value, "/") {
		return "/" + value
	}
	return value
}

func mcpNote(transport string) string {
	if transport == "stdio" {
		return "stdio 模式由 MCP 客户端启动 AutoPlan MCP 进程。"
	}
	return "默认仅监听本机地址，供本机 MCP 客户端连接。"
}

func mcpToolNames() []string {
	return []string{
		"list_projects", "get_project", "create_project", "list_requirements", "create_requirement",
		"list_feedback", "create_feedback", "list_plans", "get_plan", "list_tasks", "list_executors",
		"run_executor", "stop_executor", "start_loop", "stop_loop",
	}
}
