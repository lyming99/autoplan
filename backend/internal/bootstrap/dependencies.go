package bootstrap

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"reflect"
	"time"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationacceptance "github.com/lyming99/autoplan/backend/internal/application/acceptance"
	applicationattachments "github.com/lyming99/autoplan/backend/internal/application/attachments"
	applicationautomation "github.com/lyming99/autoplan/backend/internal/application/automation"
	applicationchat "github.com/lyming99/autoplan/backend/internal/application/chat"
	applicationconfig "github.com/lyming99/autoplan/backend/internal/application/config"
	applicationevents "github.com/lyming99/autoplan/backend/internal/application/events"
	applicationexecutors "github.com/lyming99/autoplan/backend/internal/application/executors"
	applicationidempotency "github.com/lyming99/autoplan/backend/internal/application/idempotency"
	applicationintake "github.com/lyming99/autoplan/backend/internal/application/intake"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	applicationprojects "github.com/lyming99/autoplan/backend/internal/application/projects"
	applicationscripts "github.com/lyming99/autoplan/backend/internal/application/scripts"
	applicationsnapshot "github.com/lyming99/autoplan/backend/internal/application/snapshot"
	applicationtasks "github.com/lyming99/autoplan/backend/internal/application/tasks"
	applicationterminal "github.com/lyming99/autoplan/backend/internal/application/terminal"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/domain"
	domainchat "github.com/lyming99/autoplan/backend/internal/domain/chat"
	domainterminal "github.com/lyming99/autoplan/backend/internal/domain/terminal"
	"github.com/lyming99/autoplan/backend/internal/httpapi"
	"github.com/lyming99/autoplan/backend/internal/mcp"
	mcptools "github.com/lyming99/autoplan/backend/internal/mcp/tools"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
	"github.com/lyming99/autoplan/backend/internal/repository/sqlite"
	backendruntime "github.com/lyming99/autoplan/backend/internal/runtime"
	"github.com/lyming99/autoplan/backend/internal/runtime/eventbus"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
	terminalruntime "github.com/lyming99/autoplan/backend/internal/runtime/terminal"
)

var ErrDependencyAssembly = errors.New("dependency assembly failed")

// DependencyOverrides makes every behavioral dependency replaceable without
// weakening production defaults. Random is injectable only as an in-memory
// source; session material has no argv, URL, file, or environment source.
type DependencyOverrides struct {
	Clock             application.Clock
	Readiness         application.ReadinessGate
	Repository        repository.Readiness
	ProjectRepository repository.ReadOnly
	ProjectWriter     repository.Transactional
	IntakeWriter      repository.IntakeTransactional
	PlanWriter        repository.PlanTransactional
	AutomationWriter  repository.AutomationTransactional
	ChatWriter        repository.ChatTransactional
	ChatQueueWriter   domainchat.QueueTransactional
	OperationStore    applicationoperations.Store
	OperationProjects applicationoperations.ProjectSource
	OperationHandlers []applicationoperations.RecoveryHandler
	OperationQueueAge time.Duration
	EventConfig       *config.Events
	EventStore        eventbus.Store
	EventBus          *eventbus.Bus
	EventDispatcher   *eventbus.Dispatcher
	Scheduler         *scheduler.Manager
	SchedulerClock    scheduler.Clock
	SchedulerProcess  scheduler.ProcessLauncher
	SchedulerEvents   scheduler.EventBus
	SchedulerRuntime  *config.SchedulerRuntime
	// Terminal runtime remains nil unless an explicit Files Policy is supplied.
	// P14 default-off must not create an unauthorised PTY factory during normal
	// sidecar assembly.
	TerminalRuntime     *config.TerminalRuntime
	TerminalPolicy      terminalruntime.WorkingDirectoryPolicy
	TerminalSupervisor  *terminalruntime.Supervisor
	TerminalFactory     *terminalruntime.Factory
	TerminalAuthorizer  applicationterminal.Authorizer
	TerminalWorkspace   applicationterminal.WorkspaceResolver
	TerminalAudit       applicationterminal.Auditor
	TerminalService     *applicationterminal.Service
	RuntimeDispatcher   applicationloop.Dispatcher
	LoopState           applicationloop.StateStore
	LoopRunner          applicationloop.Runner
	ScriptStore         applicationscripts.Store
	ScriptRunner        applicationscripts.Runner
	ScriptFiles         applicationscripts.FilePolicy
	ScriptFinalizer     applicationscripts.Finalizer
	ExecutorStore       applicationexecutors.Store
	ExecutorRunner      applicationexecutors.Runner
	ExecutorFiles       applicationexecutors.FilePolicy
	IntakeRuntime       applicationintake.PlanRuntime
	IntakeAttachments   applicationintake.AttachmentWorkflow
	AttachmentSnapshots applicationsnapshot.AttachmentSnapshotSource
	Attachments         *applicationattachments.Service
	Events              application.EventSink
	Logger              application.Logger
	Random              io.Reader
	MCPConfig           *mcp.Config
	MCPRegistry         *mcp.Registry
	MCPAudit            mcp.AuditSink
	// MCPAuthToken is transient material resolved by the bootstrap secret
	// boundary. It is copied into the MCP authenticator and cleared here.
	MCPAuthToken []byte
}

type Dependencies struct {
	Config             config.Config
	Application        application.Boundary
	Services           *application.Services
	Clock              application.Clock
	Readiness          application.ReadinessGate
	Repository         repository.Readiness
	ProjectRepository  repository.ReadOnly
	ProjectWriter      repository.Transactional
	IntakeWriter       repository.IntakeTransactional
	PlanWriter         repository.PlanTransactional
	AutomationWriter   repository.AutomationTransactional
	ChatWriter         repository.ChatTransactional
	ChatQueueWriter    domainchat.QueueTransactional
	Operations         *applicationoperations.Service
	OperationExecutors *applicationoperations.ExecutorRegistry
	EventBus           *eventbus.Bus
	EventDispatcher    *eventbus.Dispatcher
	Scheduler          *scheduler.Manager
	Projects           *applicationprojects.Service
	ProjectConfig      *applicationconfig.Service
	Intake             *applicationintake.Service
	Plans              *applicationplans.Service
	Loop               *applicationloop.Service
	Scripts            *applicationscripts.Service
	Executors          *applicationexecutors.Service
	TerminalService    *applicationterminal.Service
	terminalRuntime    *terminalruntime.Factory
	RuntimeBridge      *applicationloop.Bridge
	Automation         *applicationautomation.Service
	Chat               *applicationchat.Service
	StaticConfig       *applicationconfig.StaticService
	PlanEvents         *applicationevents.Service
	Attachments        *applicationattachments.Service
	MCPIntake          *mcp.IntakeTools
	MCPStatic          *mcp.StaticTools
	MCPRuntime         *mcp.RuntimeTools
	MCPRegistry        *mcp.Registry
	MCP                *mcp.Server
	Events             application.EventSink
	Logger             application.Logger
	Session            *session.Manager
	Origins            config.OriginSet
}

// SessionCopy is the only controlled handoff from bootstrap memory. Callers
// receive a copy and cannot mutate bootstrap's retained material.
func (dependencies *Dependencies) SessionCopy() []byte {
	if dependencies == nil || dependencies.Session == nil {
		return nil
	}
	return dependencies.Session.CredentialCopy()
}

// NewHTTPSecurity binds the assembled session and exact Origin set to the
// configured loopback authority. The actual random port is resolved from the
// request connection when ListenPort is zero.
func (dependencies *Dependencies) NewHTTPSecurity(logger logging.Logger, clock logging.Clock) (*httpapi.Security, error) {
	if dependencies == nil {
		return nil, httpapi.ErrSecurityConfiguration
	}
	return httpapi.NewSecurity(httpapi.SecurityOptions{
		Sessions: dependencies.Session, Origins: dependencies.Origins,
		ExpectedHost: dependencies.Config.HTTP.ListenHost,
		ExpectedPort: dependencies.Config.HTTP.ListenPort,
		Logger:       logger, Clock: clock,
	})
}

func (dependencies *Dependencies) RegisterTransportSkeletons(
	router *httpapi.Router,
	logger logging.Logger,
	clock logging.Clock,
) error {
	securityPolicy, err := dependencies.NewHTTPSecurity(logger, clock)
	if err != nil {
		return err
	}
	return httpapi.RegisterTransportSkeletons(router, securityPolicy)
}

// RegisterRuntimeRoutes composes static persistence routes and the P002
// runtime bridge behind one authenticated REST policy. It only registers on a
// caller-owned router; dependency assembly never opens a listener or storage.
func (dependencies *Dependencies) RegisterRuntimeRoutes(
	router *httpapi.Router,
	logger logging.Logger,
	clock logging.Clock,
) error {
	securityPolicy, err := dependencies.NewHTTPSecurity(logger, clock)
	if err != nil {
		return err
	}
	if err := httpapi.RegisterRuntimeBridge(router, securityPolicy, dependencies.RuntimeBridge); err != nil {
		return err
	}
	if err := httpapi.RegisterProjects(router, securityPolicy, dependencies.Projects); err != nil {
		return err
	}
	if err := httpapi.RegisterIntake(router, securityPolicy, dependencies.Intake); err != nil {
		return err
	}
	if err := httpapi.RegisterConfig(router, securityPolicy, dependencies.ProjectConfig); err != nil {
		return err
	}
	if err := httpapi.RegisterStaticConfig(router, securityPolicy, dependencies.StaticConfig); err != nil {
		return err
	}
	if err := httpapi.RegisterAutomation(router, securityPolicy, dependencies.Automation); err != nil {
		return err
	}
	if err := httpapi.RegisterProcessActionRoutes(router, securityPolicy, dependencies.Scripts, dependencies.Executors); err != nil {
		return err
	}
	if err := httpapi.RegisterPlanContent(router, securityPolicy, dependencies.Plans); err != nil {
		return err
	}
	// Project snapshots are refreshed from the durable outbox stream. Keep the
	// subscription routes in the same composition root as the mutations that
	// publish those records; omitting this registration leaves the renderer on
	// its initial snapshot even though the Loop continues in the background.
	if err := httpapi.RegisterEvents(router, securityPolicy, dependencies.Projects, dependencies.Operations, dependencies.EventBus); err != nil {
		return err
	}
	return httpapi.RegisterChatHistory(router, securityPolicy, dependencies.Chat)
}

// RegisterTerminalRoutes binds the REST control plane and private WebSocket
// data plane to one feature decision and one application service.
func (dependencies *Dependencies) RegisterTerminalRoutes(
	router *httpapi.Router,
	logger logging.Logger,
	clock logging.Clock,
	enabled bool,
	runtimeConfig config.TerminalRuntime,
) error {
	securityPolicy, err := dependencies.NewHTTPSecurity(logger, clock)
	if err != nil {
		return err
	}
	if err := httpapi.RegisterTerminals(router, securityPolicy, httpapi.TerminalRoutesOptions{
		Service: dependencies.TerminalService, FeatureEnabled: enabled,
	}); err != nil {
		return err
	}
	return httpapi.RegisterTerminalWebSocket(router, securityPolicy, httpapi.TerminalWebSocketOptions{
		Service: dependencies.TerminalService, FeatureEnabled: enabled, Runtime: runtimeConfig,
	})
}

// AssembleDependencies uses non-writing, unavailable defaults for repository
// and readiness. No filesystem path is opened or created here.
func AssembleDependencies(configuration config.Config, overrides DependencyOverrides) (*Dependencies, error) {
	configuration.HTTP.AllowedOrigins = append([]string(nil), configuration.HTTP.AllowedOrigins...)
	clock := overrides.Clock
	if clock == nil {
		clock = backendruntime.SystemClock{}
	}
	readiness := overrides.Readiness
	if readiness == nil {
		readiness = backendruntime.BlockedReadiness{}
	}
	repositoryPort := overrides.Repository
	projectRepository := overrides.ProjectRepository
	projectWriter := overrides.ProjectWriter
	intakeWriter := overrides.IntakeWriter
	planWriter := overrides.PlanWriter
	automationWriter := overrides.AutomationWriter
	chatWriter := overrides.ChatWriter
	chatQueueWriter := overrides.ChatQueueWriter
	operationStore := overrides.OperationStore
	operationProjects := overrides.OperationProjects
	scriptStore := overrides.ScriptStore
	executorStore := overrides.ExecutorStore
	eventStore := overrides.EventStore
	attachmentService := overrides.Attachments
	if attachmentService == nil {
		attachmentService, _ = overrides.IntakeAttachments.(*applicationattachments.Service)
	}
	if attachmentService == nil {
		attachmentService, _ = overrides.AttachmentSnapshots.(*applicationattachments.Service)
	}
	if projectWriter == nil {
		projectWriter, _ = overrides.Repository.(repository.Transactional)
	}
	if intakeWriter == nil {
		intakeWriter, _ = overrides.Repository.(repository.IntakeTransactional)
	}
	if planWriter == nil {
		planWriter, _ = overrides.Repository.(repository.PlanTransactional)
	}
	if automationWriter == nil {
		automationWriter, _ = overrides.Repository.(repository.AutomationTransactional)
	}
	if chatWriter == nil {
		chatWriter, _ = overrides.Repository.(repository.ChatTransactional)
	}
	if chatQueueWriter == nil {
		chatQueueWriter, _ = chatWriter.(domainchat.QueueTransactional)
	}
	if repositoryPort == nil && projectRepository != nil {
		repositoryPort = projectRepository
	}
	if repositoryPort == nil && projectWriter != nil {
		repositoryPort = projectWriter
	}
	if repositoryPort == nil && intakeWriter != nil {
		repositoryPort = intakeWriter
	}
	if repositoryPort == nil && planWriter != nil {
		repositoryPort = planWriter
	}
	if repositoryPort == nil && automationWriter != nil {
		repositoryPort = automationWriter
	}
	if repositoryPort == nil && chatWriter != nil {
		repositoryPort = chatWriter
	}
	if repositoryPort == nil {
		repositoryPort = repository.Unavailable{}
	}
	if operationStore == nil {
		for _, candidate := range []any{overrides.Repository, repositoryPort, projectWriter, intakeWriter, planWriter, automationWriter, chatWriter} {
			writer, ok := candidate.(*sqlite.Writer)
			if ok {
				operationStore = applicationoperations.NewSQLiteStore(writer)
				break
			}
		}
	}
	if eventStore == nil {
		for _, candidate := range []any{overrides.Repository, repositoryPort, projectWriter, intakeWriter, planWriter, automationWriter, chatWriter} {
			writer, ok := candidate.(*sqlite.Writer)
			if ok {
				eventStore = eventbus.NewSQLiteStore(writer)
				break
			}
		}
	}
	if projectRepository == nil {
		projectRepository, _ = repositoryPort.(repository.ReadOnly)
	}
	if operationProjects == nil {
		if source, ok := projectRepository.(applicationoperations.ProjectSource); ok {
			operationProjects = source
		} else if source, ok := projectWriter.(applicationoperations.ProjectSource); ok {
			operationProjects = source
		}
	}
	if scriptStore == nil && automationWriter != nil {
		scriptStore = applicationscripts.NewRepositoryStore(automationWriter)
	}
	if executorStore == nil && automationWriter != nil {
		executorStore = applicationexecutors.NewRepositoryStore(automationWriter)
	}
	events := overrides.Events
	if events == nil {
		events = discardEvents{}
	}
	logger := overrides.Logger
	if logger == nil {
		logger = discardLogger{}
	}
	random := overrides.Random
	if random == nil {
		random = rand.Reader
	}
	sessionManager, err := session.New(random)
	if err != nil {
		return nil, ErrDependencyAssembly
	}
	terminalSettings := config.DefaultTerminalRuntime()
	if overrides.TerminalRuntime != nil {
		terminalSettings = *overrides.TerminalRuntime
	}
	terminalFactory := overrides.TerminalFactory
	terminalConfigured := overrides.TerminalRuntime != nil || overrides.TerminalPolicy != nil || overrides.TerminalSupervisor != nil
	if terminalFactory == nil && terminalConfigured {
		if overrides.TerminalPolicy == nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
		terminalFactory, err = terminalruntime.NewFactory(terminalruntime.Dependencies{
			Config: terminalSettings, Policy: overrides.TerminalPolicy, Supervisor: overrides.TerminalSupervisor,
		})
		if err != nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
	}
	terminalService := overrides.TerminalService
	if terminalService == nil {
		terminalService = applicationterminal.NewService(applicationterminal.Dependencies{
			Factory: terminalFactory, Authorizer: overrides.TerminalAuthorizer, Workspaces: overrides.TerminalWorkspace,
			Auditor: overrides.TerminalAudit, Profiles: terminalProfiles(terminalSettings),
			DefaultProfile: terminalSettings.DefaultProfile, DefaultCols: terminalSettings.DefaultCols, DefaultRows: terminalSettings.DefaultRows,
		})
	}
	origins, err := config.NewOriginSet(configuration.HTTP.AllowedOrigins)
	if err != nil {
		sessionManager.Close()
		return nil, ErrDependencyAssembly
	}
	services, err := application.NewServices(application.ServiceDependencies{
		Clock: clock, Readiness: readiness, Repository: repositoryPort, Events: events, Logger: logger,
	})
	if err != nil {
		sessionManager.Close()
		return nil, ErrDependencyAssembly
	}
	readSession := applicationsnapshot.DirectReader(projectRepository)
	if projectWriter != nil {
		readSession = applicationsnapshot.TransactionalReader(projectWriter)
	}
	if intakeWriter != nil {
		readSession = applicationsnapshot.TransactionalIntakeReader(intakeWriter)
	}
	if planWriter != nil {
		readSession = applicationsnapshot.TransactionalPlanReader(planWriter)
	}
	if chatWriter != nil && planWriter == nil {
		readSession = applicationsnapshot.TransactionalChatReader(chatWriter)
	}
	attachmentSnapshots := overrides.AttachmentSnapshots
	if attachmentSnapshots == nil && attachmentService != nil {
		attachmentSnapshots = attachmentService
	}
	assembler := applicationsnapshot.NewWithAttachments(readSession, attachmentSnapshots)
	idempotency := applicationidempotency.New()
	projectService := applicationprojects.NewServiceWithDependencies(applicationprojects.Dependencies{
		Assembler: assembler, Writer: projectWriter, Idempotency: idempotency, Clock: clock,
	})
	configService := applicationconfig.NewService(applicationconfig.Dependencies{
		Assembler: assembler, Writer: projectWriter, Idempotency: idempotency, Clock: clock,
	})
	intakeAttachments := overrides.IntakeAttachments
	if intakeAttachments == nil && attachmentService != nil {
		intakeAttachments = attachmentService
	}
	intakeService := applicationintake.NewService(applicationintake.Dependencies{
		Assembler: assembler, Writer: intakeWriter, Idempotency: idempotency,
		Runtime: overrides.IntakeRuntime, Attachments: intakeAttachments, Clock: clock,
	})
	planService := applicationplans.NewService(applicationplans.Dependencies{
		Assembler: assembler, Writer: planWriter, Clock: clock,
	})
	automationService := applicationautomation.NewService(applicationautomation.Dependencies{
		Writer: automationWriter, Clock: clock,
	})
	chatService := applicationchat.NewService(applicationchat.Dependencies{
		Writer: chatWriter, Queue: chatQueueWriter, Clock: clock,
	})
	staticConfigService := applicationconfig.NewStaticService(applicationconfig.StaticDependencies{
		Writer: chatWriter, Clock: clock,
	})
	dispatcher := overrides.RuntimeDispatcher
	var manualDispatcher *manualRuntimeDispatcher
	if dispatcher == nil {
		for _, candidate := range []any{overrides.Repository, projectWriter, planWriter, intakeWriter} {
			if activator, ok := candidate.(repository.DraftPlanTaskActivator); ok {
				manualDispatcher = newManualRuntimeDispatcher(activator)
				dispatcher = manualDispatcher
				break
			}
		}
		if dispatcher == nil {
			dispatcher = applicationloop.UnavailableDispatcher{}
		}
	}
	planEvents := applicationevents.NewService(planWriter)
	eventSettings := config.DefaultEvents()
	eventConfigInvalid := false
	if overrides.EventConfig != nil {
		eventConfigInvalid = !overrides.EventConfig.Valid()
		eventSettings = overrides.EventConfig.Normalized()
	}
	eventBus := overrides.EventBus
	if eventBus == nil {
		eventBus = eventbus.NewBus(eventbus.Options{
			Store: eventStore, Clock: clock, SubscriptionBuffer: eventSettings.SubscriptionBuffer,
			ReplayLimit: eventSettings.ReplayLimit,
		})
	}
	eventDispatcher := overrides.EventDispatcher
	if eventDispatcher == nil {
		eventDispatcher = eventbus.NewDispatcher(eventbus.DispatcherOptions{
			Store: eventStore, Bus: eventBus, Clock: clock, DispatchBatch: eventSettings.DispatchBatch,
			Warn: func(ctx context.Context, code string) {
				logger.Log(ctx, application.LogEntry{Level: "warn", Code: code})
			},
			DispatchInterval: eventSettings.DispatchInterval, RetentionInterval: eventSettings.RetentionInterval,
			Retention: eventbus.RetentionPolicy{
				MaximumAge: eventSettings.RetentionAge, GlobalLimit: eventSettings.RetentionGlobal,
				PerProjectLimit: eventSettings.RetentionPerProject, BatchLimit: eventSettings.RetentionBatch,
			},
		})
	}
	if eventConfigInvalid {
		logger.Log(context.Background(), application.LogEntry{Level: "warn", Code: "event_config_invalid"})
	}
	runtimeScheduler := overrides.Scheduler
	if runtimeScheduler == nil {
		schedulerSettings := config.DefaultSchedulerRuntime()
		if overrides.SchedulerRuntime != nil {
			schedulerSettings = *overrides.SchedulerRuntime
		}
		if !schedulerSettings.Valid() {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
		schedulerClock := overrides.SchedulerClock
		if schedulerClock == nil {
			schedulerClock = scheduler.NewSystemClock()
		}
		var schedulerErr error
		runtimeScheduler, schedulerErr = scheduler.NewManager(scheduler.Dependencies{
			Config: scheduler.Config{
				WorkerLimit:        schedulerSettings.WorkerLimit,
				QueueCapacity:      schedulerSettings.QueueCapacity,
				ActorQueueCapacity: schedulerSettings.ActorQueueCapacity,
			},
			Clock: schedulerClock, ProcessLauncher: overrides.SchedulerProcess, EventBus: overrides.SchedulerEvents,
		})
		if schedulerErr != nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
	}
	operationExecutors := applicationoperations.NewExecutorRegistry()
	loopService := applicationloop.NewService(applicationloop.Dependencies{
		Dispatcher: dispatcher, Scheduler: runtimeScheduler, State: overrides.LoopState, Runner: overrides.LoopRunner,
	})
	for _, kind := range []applicationloop.CommandKind{applicationloop.CommandLoopStart, applicationloop.CommandLoopStop, applicationloop.CommandLoopRunOnce} {
		if err := operationExecutors.Register(applicationloop.NewOperationExecutor(loopService, kind)); err != nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
	}
	scriptService := applicationscripts.NewService(applicationscripts.Dependencies{
		Store: scriptStore, Scheduler: runtimeScheduler, Runner: overrides.ScriptRunner, Files: overrides.ScriptFiles,
		Finalizer: overrides.ScriptFinalizer, Clock: clock,
	})
	if err := operationExecutors.Register(applicationscripts.NewOperationExecutor(scriptService)); err != nil {
		sessionManager.Close()
		return nil, ErrDependencyAssembly
	}
	runtimeExecutorService := applicationexecutors.NewService(applicationexecutors.Dependencies{
		Store: executorStore, Scheduler: runtimeScheduler, Runner: overrides.ExecutorRunner, Files: overrides.ExecutorFiles, Clock: clock,
	})
	for _, operationType := range []string{applicationexecutors.OperationTypeRun, applicationexecutors.OperationTypeAction} {
		if err := operationExecutors.Register(applicationexecutors.NewOperationExecutor(runtimeExecutorService, operationType)); err != nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
	}
	operationHandlers := append([]applicationoperations.RecoveryHandler(nil), overrides.OperationHandlers...)
	operationHandlers = append(operationHandlers, operationExecutors.RecoveryHandlers()...)
	operationHandlers = append(operationHandlers, applicationacceptance.RecoveryHandlers()...)
	if manualDispatcher != nil {
		operationHandlers = append(operationHandlers,
			manualRecoveryHandler{operationType: string(applicationloop.CommandTaskRun)},
			manualRecoveryHandler{operationType: string(applicationloop.CommandTaskRunBatches)},
			manualRecoveryHandler{operationType: string(applicationloop.CommandTaskStop)},
		)
	}
	operationService := applicationoperations.NewService(applicationoperations.Dependencies{
		Store: operationStore, Projects: operationProjects, Clock: clock,
		QueuedRecoveryMaxAge: overrides.OperationQueueAge, RecoveryHandlers: operationHandlers,
	})
	loopService.BindOperations(operationService)
	manualDispatcher.Bind(operationService, loopService)
	scriptService.BindOperations(operationService)
	runtimeExecutorService.BindOperations(operationService)
	assembler.BindScripts(scriptService)
	assembler.BindExecutors(runtimeExecutorService)
	assembler.BindOperations(operationService)
	runtimeBridge, err := applicationloop.NewBridge(
		loopService,
		applicationacceptance.NewRuntimeHandler(planService, operationService),
		applicationplans.NewRuntimeHandler(dispatcher),
		applicationtasks.NewRuntimeHandler(dispatcher),
		applicationchat.NewRuntimeHandler(dispatcher),
		applicationautomation.NewRuntimeHandler(dispatcher),
		applicationconfig.NewRuntimeHandler(dispatcher),
	)
	if err != nil {
		sessionManager.Close()
		return nil, ErrDependencyAssembly
	}
	mcpIntake := mcp.NewIntakeTools(mcp.Dependencies{
		Intake: intakeService, Attachments: attachmentService, Projects: projectService,
	})
	mcpStatic := mcp.NewStaticTools(mcp.StaticDependencies{
		Automation: automationService, Chat: chatService, Config: staticConfigService,
	})
	mcpRuntime := mcp.NewRuntimeTools(mcp.RuntimeDependencies{Bridge: runtimeBridge})
	mcpConfig := mcp.DefaultConfig()
	if overrides.MCPConfig != nil {
		mcpConfig = *overrides.MCPConfig
		mcpConfig.AllowedOrigins = append([]string(nil), overrides.MCPConfig.AllowedOrigins...)
	}
	mcpRegistry := overrides.MCPRegistry
	if mcpRegistry == nil {
		mcpRegistry, err = mcp.NewRegistry(mcptools.Catalog(), mcptools.NewFactory(mcptools.Dependencies{
			Projects: projectService, Intake: intakeService, Attachments: attachmentService,
			Plans: planService, ExecutorCatalog: automationService, Executors: runtimeExecutorService,
			Runtime: runtimeBridge,
		}))
		if err != nil {
			sessionManager.Close()
			return nil, ErrDependencyAssembly
		}
	}
	mcpSessionToken := sessionManager.CredentialCopy()
	mcpAuthToken := append([]byte(nil), overrides.MCPAuthToken...)
	if len(mcpAuthToken) == 0 {
		mcpAuthToken = append([]byte(nil), mcpSessionToken...)
	}
	mcpServer, err := mcp.NewServer(mcp.ServerOptions{
		Config: mcpConfig, Registry: mcpRegistry, Audit: overrides.MCPAudit,
		SessionToken: mcpSessionToken, AuthToken: mcpAuthToken,
	})
	for index := range mcpSessionToken {
		mcpSessionToken[index] = 0
	}
	for index := range mcpAuthToken {
		mcpAuthToken[index] = 0
	}
	if err != nil {
		sessionManager.Close()
		return nil, ErrDependencyAssembly
	}
	assembler.BindMCPRuntime(func() map[string]any {
		status := mcpServer.Status()
		return map[string]any{
			"enabled": status.Enabled, "running": status.Running, "status": status.State,
			"transport": status.Transport, "host": status.Host, "port": status.Port, "url": status.URL,
			"hasAuthToken": status.HasAuthToken, "authTokenMasked": status.AuthTokenMasked,
			"authHeader": status.AuthHeader, "localOnly": status.LocalOnly,
			"tools": status.Tools, "toolDocs": []any{}, "connectionExample": status.ConnectionExample,
			"note": status.Note, "lastError": status.LastError, "startedAt": status.StartedAt,
		}
	})
	return &Dependencies{
		Config: configuration, Application: services, Services: services,
		Clock: clock, Readiness: readiness, Repository: repositoryPort,
		ProjectRepository: projectRepository, ProjectWriter: projectWriter,
		IntakeWriter: intakeWriter, PlanWriter: planWriter, AutomationWriter: automationWriter, ChatWriter: chatWriter, ChatQueueWriter: chatQueueWriter,
		Projects: projectService, ProjectConfig: configService, Intake: intakeService,
		Plans: planService, Loop: loopService, Scripts: scriptService, Executors: runtimeExecutorService, TerminalService: terminalService, terminalRuntime: terminalFactory, RuntimeBridge: runtimeBridge,
		Operations: operationService, OperationExecutors: operationExecutors, EventBus: eventBus, EventDispatcher: eventDispatcher, Scheduler: runtimeScheduler,
		Automation: automationService, Chat: chatService, StaticConfig: staticConfigService, PlanEvents: planEvents,
		Attachments: attachmentService, MCPIntake: mcpIntake, MCPStatic: mcpStatic, MCPRuntime: mcpRuntime,
		MCPRegistry: mcpRegistry, MCP: mcpServer,
		Events: events, Logger: logger,
		Session: sessionManager, Origins: origins,
	}, nil
}

// RecoverOperations runs before the process accepts runtime work whenever a
// P10 Operation store is configured. The event dispatcher starts only after
// recovery has committed its interruption records, so it can replay those
// events without racing an un-recovered Operation.
func (dependencies *Dependencies) RecoverOperations(ctx context.Context) error {
	if dependencies == nil {
		return nil
	}
	if dependencies.Operations != nil && dependencies.Operations.Configured() {
		if _, err := dependencies.Operations.Recover(ctx); err != nil {
			return err
		}
	}
	if dependencies.Loop != nil {
		if err := dependencies.Loop.Recover(ctx); err != nil {
			return err
		}
	}
	if dependencies.Chat != nil {
		if _, err := dependencies.Chat.Recover(ctx); err != nil {
			return err
		}
	}
	if dependencies.OperationExecutors != nil {
		if err := dependencies.OperationExecutors.ResumeClaimed(ctx); err != nil {
			return err
		}
	}
	return dependencies.StartEventDispatcher(ctx)
}

func (dependencies *Dependencies) StartEventDispatcher(ctx context.Context) error {
	if dependencies == nil || dependencies.EventDispatcher == nil || !dependencies.EventDispatcher.Configured() {
		return nil
	}
	return dependencies.EventDispatcher.Start(ctx)
}

// StartMCP starts only the independently-gated HTTP transport. stdio is
// owned by its explicit command entrypoint, so a daemon cannot accidentally
// bind both transports or create a second listener.
func (dependencies *Dependencies) StartMCP(ctx context.Context) error {
	if dependencies == nil || dependencies.MCP == nil || !dependencies.MCP.Status().Enabled {
		return nil
	}
	return dependencies.MCP.Start(ctx)
}

func (dependencies *Dependencies) Close(ctx context.Context) error {
	if dependencies == nil {
		return nil
	}
	var first error
	if dependencies.TerminalService != nil {
		dependencies.TerminalService.Shutdown(ctx)
	}
	if dependencies.terminalRuntime != nil {
		dependencies.terminalRuntime.Shutdown()
	}
	if dependencies.MCP != nil {
		if err := dependencies.MCP.Close(ctx); err != nil {
			first = err
		}
	}
	if dependencies.Loop != nil {
		if err := dependencies.Loop.Close(ctx); err != nil {
			first = err
		}
	}
	if dependencies.Scripts != nil {
		dependencies.Scripts.Close()
	}
	if dependencies.Executors != nil {
		dependencies.Executors.Close()
	}
	if dependencies.Scheduler != nil {
		if err := dependencies.Scheduler.Close(ctx); err != nil {
			first = err
		}
	}
	if dependencies.EventDispatcher != nil {
		if err := dependencies.EventDispatcher.Close(ctx); first == nil && err != nil {
			first = err
		}
	}
	if dependencies.EventBus != nil {
		if err := dependencies.EventBus.Close(ctx); first == nil && err != nil {
			first = err
		}
	}
	if dependencies.Session != nil {
		dependencies.Session.Close()
	}
	closed := make([]any, 0, 6)
	for _, candidate := range []any{
		dependencies.PlanWriter,
		dependencies.AutomationWriter,
		dependencies.ChatWriter,
		dependencies.IntakeWriter,
		dependencies.ProjectWriter,
		dependencies.ProjectRepository,
	} {
		if candidate == nil {
			continue
		}
		duplicate := false
		for _, previous := range closed {
			if sameDependency(candidate, previous) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		closer, ok := candidate.(interface{ Close() error })
		if !ok {
			continue
		}
		if err := closer.Close(); first == nil {
			first = err
		}
		closed = append(closed, candidate)
	}
	return first
}

func sameDependency(left, right any) bool {
	leftType, rightType := reflect.TypeOf(left), reflect.TypeOf(right)
	if leftType == nil || leftType != rightType || !leftType.Comparable() {
		return false
	}
	return reflect.ValueOf(left).Interface() == reflect.ValueOf(right).Interface()
}

// terminalProfiles converts immutable launch configuration into the safe
// metadata projection consumed by the shared application service. Environment
// values intentionally do not cross this boundary.
func terminalProfiles(runtime config.TerminalRuntime) []domainterminal.Profile {
	profiles := make([]domainterminal.Profile, 0, len(runtime.Profiles))
	for _, profile := range runtime.Profiles {
		kind := "custom"
		if profile.ID == runtime.DefaultProfile {
			kind = "default"
		}
		profiles = append(profiles, domainterminal.Profile{
			ID: profile.ID, Name: profile.ID, Kind: kind, ShellPath: profile.Executable, Args: append([]string(nil), profile.Args...),
		})
	}
	return profiles
}

type discardEvents struct{}

func (discardEvents) Publish(context.Context, domain.Service) error { return nil }

type discardLogger struct{}

func (discardLogger) Log(context.Context, application.LogEntry) {}
