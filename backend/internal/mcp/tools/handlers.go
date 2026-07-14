package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	applicationautomation "github.com/lyming99/autoplan/backend/internal/application/automation"
	applicationintake "github.com/lyming99/autoplan/backend/internal/application/intake"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	applicationprojects "github.com/lyming99/autoplan/backend/internal/application/projects"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/mcp"
)

// ProjectApplication and PlanApplication are deliberately application-level
// facets. The MCP package never receives a repository, SQL handle, file
// system, process runner, scheduler, or domain state-machine write API.
type ProjectApplication interface {
	List(context.Context, domainproject.Visibility) ([]contracts.Project, error)
	Get(context.Context, int64, domainproject.Visibility) (contracts.Project, error)
	Snapshot(context.Context, *int64, domainproject.Visibility) (contracts.AppSnapshot, error)
	Create(context.Context, applicationprojects.CreateCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
}

type PlanApplication interface {
	List(context.Context, applicationplans.ListQuery) ([]applicationplans.PlanDTO, error)
	Get(context.Context, int64, int64) (applicationplans.PlanDTO, error)
	ListTasks(context.Context, int64, int64) ([]applicationplans.TaskDTO, error)
}

// Dependencies contains only already-assembled shared service facets. The
// legacy adapter structs are used solely as typed application-service callers
// and retain their existing authorization/idempotency/error mappings.
type Dependencies struct {
	Projects        ProjectApplication
	Intake          mcp.IntakeApplication
	Attachments     mcp.AttachmentApplication
	Plans           PlanApplication
	ExecutorCatalog mcp.ExecutorCatalog
	Executors       mcp.ExecutorApplication
	Runtime         mcp.RuntimeApplication
}

type Factory struct {
	projects  ProjectApplication
	plans     PlanApplication
	catalog   mcp.ExecutorCatalog
	intake    *mcp.IntakeTools
	executors *mcp.ExecutorTools
	runtime   *mcp.RuntimeTools
}

func NewFactory(dependencies Dependencies) *Factory {
	return &Factory{
		projects: dependencies.Projects, plans: dependencies.Plans, catalog: dependencies.ExecutorCatalog,
		intake:    mcp.NewIntakeTools(mcp.Dependencies{Intake: dependencies.Intake, Attachments: dependencies.Attachments, Projects: dependencies.Projects}),
		executors: mcp.NewExecutorTools(mcp.ExecutorToolDependencies{Executors: dependencies.Executors, Catalog: dependencies.ExecutorCatalog}),
		runtime:   mcp.NewRuntimeTools(mcp.RuntimeDependencies{Bridge: dependencies.Runtime}),
	}
}

// Handler implements mcp.AdapterFactory. Every descriptor receives the same
// factory instance, so HTTP and stdio invoke exactly one adapter mapping.
func (factory *Factory) Handler(descriptor mcp.ToolDescriptor) mcp.ToolHandler {
	if factory == nil || !knownTool(descriptor.Name) {
		return nil
	}
	return mcp.ToolHandlerFunc(factory.call)
}

func (factory *Factory) call(ctx context.Context, call mcp.ToolCall) (mcp.ToolResult, error) {
	request := caller(call.Context)
	var value any
	var err error
	switch call.Name {
	case ListProjects:
		value, err = factory.listProjects(ctx, call.Arguments)
	case GetProject:
		value, err = factory.getProject(ctx, call.Arguments)
	case CreateProject:
		value, err = factory.createProject(ctx, request, call.Arguments)
	case ListRequirements:
		value, err = factory.listIntakes(ctx, call.Arguments, domainintake.Requirement)
	case CreateRequirement:
		value, err = factory.createIntake(ctx, request, call.Arguments, false)
	case GetRequirement:
		value, err = factory.getIntake(ctx, call.Arguments, domainintake.Requirement)
	case UpdateRequirement:
		value, err = factory.updateIntake(ctx, request, call.Arguments, false)
	case DeleteRequirement:
		value, err = factory.deleteIntake(ctx, request, call.Arguments, domainintake.Requirement)
	case ListRequirementPlanLinks:
		value, err = factory.links(ctx, call.Arguments, domainintake.Requirement)
	case ReplaceRequirementPlanLinks:
		value, err = factory.replaceLinks(ctx, request, call.Arguments, domainintake.Requirement)
	case UploadRequirementAttachment:
		value, err = factory.uploadAttachment(ctx, request, call.Arguments, domainintake.Requirement)
	case ListFeedback:
		value, err = factory.listIntakes(ctx, call.Arguments, domainintake.Feedback)
	case CreateFeedback:
		value, err = factory.createIntake(ctx, request, call.Arguments, true)
	case GetFeedback:
		value, err = factory.getIntake(ctx, call.Arguments, domainintake.Feedback)
	case UpdateFeedback:
		value, err = factory.updateIntake(ctx, request, call.Arguments, true)
	case DeleteFeedback:
		value, err = factory.deleteIntake(ctx, request, call.Arguments, domainintake.Feedback)
	case ListFeedbackPlanLinks:
		value, err = factory.links(ctx, call.Arguments, domainintake.Feedback)
	case ReplaceFeedbackPlanLinks:
		value, err = factory.replaceLinks(ctx, request, call.Arguments, domainintake.Feedback)
	case UploadFeedbackAttachment:
		value, err = factory.uploadAttachment(ctx, request, call.Arguments, domainintake.Feedback)
	case DeleteAttachment:
		value, err = factory.deleteAttachment(ctx, request, call.Arguments)
	case ListPlans:
		value, err = factory.listPlans(ctx, call.Arguments)
	case GetPlan:
		value, err = factory.getPlan(ctx, call.Arguments)
	case ListTasks:
		value, err = factory.listTasks(ctx, call.Arguments)
	case ListExecutors:
		value, err = factory.listExecutors(ctx, call.Arguments)
	case RunExecutor:
		value, err = factory.executorAction(ctx, request, call.Arguments, true)
	case StopExecutor:
		value, err = factory.executorAction(ctx, request, call.Arguments, false)
	case StartLoop:
		value, err = factory.loopAction(ctx, request, call.Arguments, true)
	case StopLoop:
		value, err = factory.loopAction(ctx, request, call.Arguments, false)
	default:
		return mcp.ToolResult{}, mcp.ToolError{Code: "mcp_tool_not_found"}
	}
	if err != nil {
		return mcp.ToolResult{}, mapError(err)
	}
	return toolResult(value)
}

func (factory *Factory) listProjects(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "query", "limit")
	if err != nil {
		return nil, err
	}
	limit, err := optionalLimit(input)
	if err != nil {
		return nil, err
	}
	query, err := optionalString(input, "query", 200)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.projects == nil {
		return nil, unavailable()
	}
	items, err := factory.projects.List(ctx, domainproject.Visibility{})
	if err != nil {
		return nil, err
	}
	if query != nil && *query != "" {
		filtered := make([]contracts.Project, 0, len(items))
		needle := strings.ToLower(*query)
		for _, item := range items {
			if strings.Contains(strings.ToLower(item.Name), needle) || strings.Contains(strings.ToLower(item.Description), needle) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	if len(items) > limit {
		items = items[:limit]
	}
	return map[string]any{"projects": items}, nil
}

func (factory *Factory) getProject(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.projects == nil {
		return nil, unavailable()
	}
	project, err := factory.projects.Get(ctx, projectID, domainproject.Visibility{})
	if err != nil {
		return nil, err
	}
	snapshot, err := factory.projects.Snapshot(ctx, &projectID, domainproject.Visibility{})
	if err != nil {
		return nil, err
	}
	return map[string]any{"project": project, "snapshot": snapshot}, nil
}

func (factory *Factory) createProject(ctx context.Context, request mcp.ToolContext, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "name", "workspacePath", "description", "agentCliProvider", "agentCliCommand", "codexReasoningEffort", "planGenerationStrategy", "planGenerationProvider", "planGenerationCommand", "planGenerationModel", "planGenerationCodexReasoningEffort", "planExecutionStrategy", "planExecutionProvider", "planExecutionCommand", "planExecutionModel", "planExecutionCodexReasoningEffort")
	if err != nil {
		return nil, err
	}
	name, err := requiredString(input, "name", 120)
	if err != nil {
		return nil, err
	}
	workspace, err := requiredString(input, "workspacePath", 1000)
	if err != nil {
		return nil, err
	}
	description, err := optionalString(input, "description", 5000)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.projects == nil {
		return nil, unavailable()
	}
	project := domainproject.Create{Name: name, WorkspacePath: workspace}
	if description != nil {
		project.Description = *description
	}
	if request.IdempotencyKey == "" {
		digest := sha256.Sum256(append([]byte(request.CallerScope+"\x00"+request.RequestID+"\x00"), source...))
		request.IdempotencyKey = "mcp-" + hex.EncodeToString(digest[:20])
	}
	snapshot, err := factory.projects.Create(ctx, applicationprojects.CreateCommand{Project: project, Metadata: applicationprojects.MutationMetadata{CallerScope: request.CallerScope, IdempotencyKey: request.IdempotencyKey, RequestID: request.RequestID}}, domainproject.Visibility{})
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": snapshot.ActiveProjectID, "snapshot": snapshot}, nil
}

func (factory *Factory) listIntakes(ctx context.Context, source json.RawMessage, kind domainintake.Type) (any, error) {
	input, err := decodeObject(source, "projectId", "status", "limit")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	limit, err := optionalLimit(input)
	if err != nil {
		return nil, err
	}
	status, err := optionalStatus(input, "status")
	if err != nil {
		return nil, err
	}
	if status != nil && *status == domainintake.StatusDraft {
		return nil, invalidInput()
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	listInput := mcp.ListRequest{ProjectID: projectID, Status: status, Limit: limit}
	var items []applicationintake.IntakeDTO
	if kind == domainintake.Feedback {
		items, err = factory.intake.ListFeedback(ctx, listInput)
	} else {
		items, err = factory.intake.ListRequirements(ctx, listInput)
	}
	if err != nil {
		return nil, err
	}
	key := "requirements"
	if kind == domainintake.Feedback {
		key = "feedback"
	}
	return map[string]any{"projectId": projectID, key: items}, nil
}

func (factory *Factory) createIntake(ctx context.Context, request mcp.ToolContext, source json.RawMessage, feedback bool) (any, error) {
	input, err := decodeIntakeCreate(source, feedback)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	var result mcp.IntakeMutation
	if feedback {
		result, err = factory.intake.CreateFeedback(ctx, request, input)
	} else {
		result, err = factory.intake.CreateRequirement(ctx, request, input)
	}
	if err != nil {
		return nil, err
	}
	key := "requirement"
	if feedback {
		key = "feedback"
	}
	return map[string]any{"projectId": input.ProjectID, key: result, "snapshot": result.Mutation.Snapshot}, nil
}

func (factory *Factory) getIntake(ctx context.Context, source json.RawMessage, kind domainintake.Type) (any, error) {
	projectID, id, err := itemIDs(source)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	input := mcp.ItemRequest{ProjectID: projectID, ID: id}
	var item applicationintake.IntakeDTO
	if kind == domainintake.Feedback {
		item, err = factory.intake.GetFeedback(ctx, input)
	} else {
		item, err = factory.intake.GetRequirement(ctx, input)
	}
	if err != nil {
		return nil, err
	}
	key := "requirement"
	if kind == domainintake.Feedback {
		key = "feedback"
	}
	return map[string]any{"projectId": projectID, key: item}, nil
}

func (factory *Factory) updateIntake(ctx context.Context, request mcp.ToolContext, source json.RawMessage, feedback bool) (any, error) {
	input, err := decodeIntakeUpdate(source, feedback)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	var result applicationintake.MutationResult
	if feedback {
		result, err = factory.intake.UpdateFeedback(ctx, request, input)
	} else {
		result, err = factory.intake.UpdateRequirement(ctx, request, input)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": input.ProjectID, "snapshot": result.Snapshot}, nil
}

func (factory *Factory) deleteIntake(ctx context.Context, request mcp.ToolContext, source json.RawMessage, kind domainintake.Type) (any, error) {
	projectID, id, err := itemIDs(source)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	input := mcp.ItemRequest{ProjectID: projectID, ID: id}
	var result applicationintake.MutationResult
	if kind == domainintake.Feedback {
		result, err = factory.intake.DeleteFeedback(ctx, request, input)
	} else {
		result, err = factory.intake.DeleteRequirement(ctx, request, input)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "snapshot": result.Snapshot}, nil
}

func (factory *Factory) links(ctx context.Context, source json.RawMessage, kind domainintake.Type) (any, error) {
	projectID, id, err := itemIDs(source)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	input := mcp.ItemRequest{ProjectID: projectID, ID: id}
	var items []applicationintake.LinkedPlanDTO
	if kind == domainintake.Feedback {
		items, err = factory.intake.FeedbackLinks(ctx, input)
	} else {
		items, err = factory.intake.RequirementLinks(ctx, input)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "links": items}, nil
}

func (factory *Factory) replaceLinks(ctx context.Context, request mcp.ToolContext, source json.RawMessage, kind domainintake.Type) (any, error) {
	input, err := decodeObject(source, "projectId", "id", "links")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	id, err := requiredInt(input, "id")
	if err != nil {
		return nil, err
	}
	raw, exists := input["links"]
	if !exists {
		return nil, invalidInput()
	}
	var links []domainintake.PlanLinkInput
	if json.Unmarshal(raw, &links) != nil || len(links) > 200 {
		return nil, invalidInput()
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	value := mcp.ReplaceLinksRequest{ProjectID: projectID, ID: id, Links: links}
	var result applicationintake.MutationResult
	if kind == domainintake.Feedback {
		result, err = factory.intake.ReplaceFeedbackLinks(ctx, request, value)
	} else {
		result, err = factory.intake.ReplaceRequirementLinks(ctx, request, value)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "snapshot": result.Snapshot}, nil
}

func (factory *Factory) uploadAttachment(ctx context.Context, request mcp.ToolContext, source json.RawMessage, kind domainintake.Type) (any, error) {
	value, err := decodeObject(source, "projectId", "id", "name", "type", "path", "base64", "dataBase64", "dataUrl", "bytes")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(value, "projectId")
	if err != nil {
		return nil, err
	}
	id, err := requiredInt(value, "id")
	if err != nil {
		return nil, err
	}
	attachment, err := decodeAttachment(source)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	owner := mcp.ItemRequest{ProjectID: projectID, ID: id}
	var result any
	if kind == domainintake.Feedback {
		result, err = factory.intake.UploadFeedbackAttachment(ctx, request, owner, attachment)
	} else {
		result, err = factory.intake.UploadRequirementAttachment(ctx, request, owner, attachment)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "attachment": result}, nil
}

func (factory *Factory) deleteAttachment(ctx context.Context, request mcp.ToolContext, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId", "attachmentId")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	id, err := requiredInt(input, "attachmentId")
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.intake == nil {
		return nil, unavailable()
	}
	result, err := factory.intake.DeleteAttachment(ctx, request, mcp.AttachmentRequest{ProjectID: projectID, AttachmentID: id})
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "attachment": result}, nil
}

func (factory *Factory) listPlans(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId", "status", "limit")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	limit, err := optionalLimit(input)
	if err != nil {
		return nil, err
	}
	status, err := optionalString(input, "status", 32)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.plans == nil {
		return nil, unavailable()
	}
	items, err := factory.plans.List(ctx, applicationplans.ListQuery{ProjectID: projectID, Limit: limit})
	if err != nil {
		return nil, err
	}
	if status != nil {
		filtered := make([]applicationplans.PlanDTO, 0, len(items))
		for _, item := range items {
			if string(item.Status) == *status {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	return map[string]any{"projectId": projectID, "plans": items}, nil
}

func (factory *Factory) getPlan(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId", "planId")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	planID, err := requiredInt(input, "planId")
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.plans == nil {
		return nil, unavailable()
	}
	plan, err := factory.plans.Get(ctx, projectID, planID)
	if err != nil {
		return nil, err
	}
	tasks, err := factory.plans.ListTasks(ctx, projectID, planID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "plan": plan, "tasks": tasks}, nil
}

func (factory *Factory) listTasks(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId", "planId", "status", "limit")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	planID, err := optionalInt(input, "planId")
	if err != nil {
		return nil, err
	}
	limit, err := optionalLimit(input)
	if err != nil {
		return nil, err
	}
	status, err := optionalString(input, "status", 32)
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.plans == nil {
		return nil, unavailable()
	}
	planIDs := []int64{}
	if planID != nil {
		planIDs = append(planIDs, *planID)
	} else {
		plans, listErr := factory.plans.List(ctx, applicationplans.ListQuery{ProjectID: projectID, Limit: 200})
		if listErr != nil {
			return nil, listErr
		}
		for _, plan := range plans {
			planIDs = append(planIDs, plan.ID)
		}
	}
	tasks := make([]applicationplans.TaskDTO, 0)
	for _, id := range planIDs {
		items, listErr := factory.plans.ListTasks(ctx, projectID, id)
		if listErr != nil {
			return nil, listErr
		}
		for _, item := range items {
			if status == nil || string(item.Status) == *status {
				tasks = append(tasks, item)
				if len(tasks) == limit {
					return map[string]any{"projectId": projectID, "tasks": tasks}, nil
				}
			}
		}
	}
	return map[string]any{"projectId": projectID, "tasks": tasks}, nil
}

func (factory *Factory) listExecutors(ctx context.Context, source json.RawMessage) (any, error) {
	input, err := decodeObject(source, "projectId", "label", "group", "status", "enabled", "limit")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	limit, err := optionalLimit(input)
	if err != nil {
		return nil, err
	}
	label, err := optionalString(input, "label", 200)
	if err != nil {
		return nil, err
	}
	group, err := optionalString(input, "group", 120)
	if err != nil {
		return nil, err
	}
	status, err := optionalString(input, "status", 32)
	if err != nil {
		return nil, err
	}
	enabled, err := optionalBool(input, "enabled")
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.catalog == nil {
		return nil, unavailable()
	}
	items, err := factory.catalog.ListExecutors(ctx, applicationautomation.ListQuery{ProjectID: projectID, Limit: 200})
	if err != nil {
		return nil, err
	}
	filtered := make([]applicationautomation.ExecutorDTO, 0, len(items))
	for _, item := range items {
		if label != nil && !strings.Contains(strings.ToLower(item.Label), strings.ToLower(*label)) {
			continue
		}
		if group != nil && (item.GroupKind == nil || *item.GroupKind != *group) {
			continue
		}
		if status != nil && (item.LastStatus == nil || *item.LastStatus != *status) {
			continue
		}
		if enabled != nil && item.Enabled != *enabled {
			continue
		}
		filtered = append(filtered, item)
		if len(filtered) == limit {
			break
		}
	}
	return map[string]any{"projectId": projectID, "executors": filtered}, nil
}

func (factory *Factory) executorAction(ctx context.Context, request mcp.ToolContext, source json.RawMessage, run bool) (any, error) {
	input, err := decodeObject(source, "projectId", "executorId", "label")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	executorID, err := optionalInt(input, "executorId")
	if err != nil {
		return nil, err
	}
	label, err := optionalString(input, "label", 200)
	if err != nil {
		return nil, err
	}
	if (executorID == nil) == (label == nil || *label == "") {
		return nil, invalidInput()
	}
	if factory == nil || factory.executors == nil {
		return nil, unavailable()
	}
	value := mcp.ExecutorToolRequest{ProjectID: projectID, ExecutorID: executorID}
	if label != nil {
		value.Label = *label
	}
	if run {
		result, actionErr := factory.executors.Run(ctx, request, value)
		if actionErr != nil {
			return nil, actionErr
		}
		return map[string]any{"projectId": projectID, "operation": result.Operation, "changed": result.Changed}, nil
	}
	result, err := factory.executors.Stop(ctx, request, value)
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "operation": result.Operation, "stopped": result.Stopped, "changed": result.Changed}, nil
}

func (factory *Factory) loopAction(ctx context.Context, request mcp.ToolContext, source json.RawMessage, start bool) (any, error) {
	input, err := decodeObject(source, "projectId")
	if err != nil {
		return nil, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return nil, err
	}
	if factory == nil || factory.runtime == nil {
		return nil, unavailable()
	}
	var result any
	if start {
		result, err = factory.runtime.LoopStart(ctx, request, projectID)
	} else {
		result, err = factory.runtime.LoopStop(ctx, request, projectID)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"projectId": projectID, "result": result}, nil
}

func itemIDs(source json.RawMessage) (int64, int64, error) {
	input, err := decodeObject(source, "projectId", "id")
	if err != nil {
		return 0, 0, err
	}
	projectID, err := requiredInt(input, "projectId")
	if err != nil {
		return 0, 0, err
	}
	id, err := requiredInt(input, "id")
	if err != nil {
		return 0, 0, err
	}
	return projectID, id, nil
}

func unavailable() error { return mcp.ToolError{Code: "mcp_tool_unavailable"} }

func mapError(err error) error {
	if err == nil {
		return nil
	}
	var coded mcp.ToolError
	if errors.As(err, &coded) {
		if coded.Code == "invalid_request" {
			return mcp.ToolError{Code: "mcp_tool_invalid"}
		}
		if coded.Code == "operation_cancelled" {
			return mcp.ToolError{Code: "mcp_tool_conflict"}
		}
		return coded
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return mcp.ToolError{Code: "mcp_tool_timeout"}
	}
	if errors.Is(err, domainproject.ErrUnavailable) {
		return mcp.ToolError{Code: "service_unavailable"}
	}
	if errors.Is(err, domainproject.ErrNotFound) {
		return mcp.ToolError{Code: "not_found"}
	}
	if errors.Is(err, domainproject.ErrInvalidRecord) {
		return mcp.ToolError{Code: "mcp_tool_invalid"}
	}
	if errors.Is(err, domainproject.ErrRelation) || errors.Is(err, domainproject.ErrRunning) {
		return mcp.ToolError{Code: "mcp_tool_conflict"}
	}
	if errors.Is(err, applicationplans.ErrUnavailable) || errors.Is(err, applicationautomation.ErrUnavailable) {
		return mcp.ToolError{Code: "service_unavailable"}
	}
	if errors.Is(err, applicationplans.ErrInvalidCommand) || errors.Is(err, applicationautomation.ErrInvalidCommand) {
		return mcp.ToolError{Code: "mcp_tool_invalid"}
	}
	return mcp.ToolError{Code: "mcp_tool_internal"}
}
