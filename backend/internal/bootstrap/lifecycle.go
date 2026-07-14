package bootstrap

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	applicationruntime "github.com/lyming99/autoplan/backend/internal/application/runtime"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/httpapi"
	"github.com/lyming99/autoplan/backend/internal/mcp"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	storesqlite "github.com/lyming99/autoplan/backend/internal/repository/sqlite"
	backendruntime "github.com/lyming99/autoplan/backend/internal/runtime"
	runtimelifecycle "github.com/lyming99/autoplan/backend/internal/runtime/lifecycle"
	processruntime "github.com/lyming99/autoplan/backend/internal/runtime/process"
	"github.com/lyming99/autoplan/backend/migrations"
)

const (
	daemonReadinessVersion = 1
	daemonReadinessType    = "autoplan_daemon_ready"
	daemonSessionType      = "autoplan_daemon_session"
	daemonSessionBytes     = 32
	daemonSessionLength    = 43
	daemonMaxSessionInput  = 512
	daemonOrigin           = "http://127.0.0.1:1"
)

var daemonReadinessDependencies = []string{
	"configuration", "session", ReadinessDatabaseOwner, ReadinessMigrations, ReadinessDatabase, "application", "listener",
}

type daemonOptions struct {
	DataDir string
}

type daemonSessionMessage struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Session string `json:"session"`
}

// daemonReadinessMessage is intentionally the entire stdout protocol. It
// contains only a public loopback address, process identity, lock state, and
// a one-way proof; the session credential never crosses stdout or stderr.
type daemonReadinessMessage struct {
	Version      int    `json:"version"`
	Type         string `json:"type"`
	PID          int    `json:"pid"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Ready        bool   `json:"ready"`
	Lock         string `json:"lock"`
	SessionProof string `json:"session_proof"`
}

// RunDaemonCommand owns the constrained Electron daemon lifecycle. It accepts
// only an explicitly supplied temporary data directory and a session supplied
// once through stdin. It never discovers userData, reads a session from argv
// or environment, or writes a readiness failure to stdout.
func RunDaemonCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) (exitCode int) {
	options, err := parseDaemonOptions(args)
	if err != nil {
		return daemonFailure(stderr, exitUsage)
	}
	features, err := config.RuntimeFeaturesFromEnvironment(os.Environ())
	if err != nil {
		return daemonFailure(stderr, exitBlocked)
	}
	sessionText, sessionRaw, parentPipe, err := readDaemonSession(stdin)
	if err != nil {
		return daemonFailure(stderr, exitBlocked)
	}
	defer zeroDaemonBytes(sessionRaw)
	dataDir, databasePath, err := validateDaemonDataDirectory(options.DataDir)
	if err != nil {
		return daemonFailure(stderr, exitBlocked)
	}
	clock := backendruntime.SystemClock{}
	logger, err := logging.NewJSONLogger(stderr, clock)
	if err != nil {
		return daemonFailure(stderr, exitFailure)
	}
	_ = logger.Log(logging.Event{Level: "info", Code: "daemon_process_started", Stage: "startup"})
	defer func() {
		event := logging.Event{Level: "info", Code: "daemon_process_stopped", Stage: "shutdown", ExitCode: exitCode}
		if exitCode != exitOK {
			event.Level = "error"
			event.ErrorCode = "daemon_exit_nonzero"
		}
		_ = logger.Log(event)
	}()

	runContext, stopSignals := signal.NotifyContext(ctx, runtimelifecycle.TerminationSignals()...)
	defer stopSignals()
	runContext, stopParentWatch := context.WithCancel(runContext)
	defer stopParentWatch()
	watchDaemonParent(parentPipe, stopParentWatch)
	readiness, err := NewReadiness(daemonReadinessDependencies...)
	if err != nil {
		return daemonFailure(stderr, exitFailure)
	}
	_ = readiness.MarkReady("configuration")
	_ = readiness.MarkReady("session")

	manager, err := runtimelifecycle.New(readiness, 10*time.Second)
	if err != nil {
		return daemonFailure(stderr, exitFailure)
	}
	applicationGate, err := readiness.Gate("application", "listener")
	if err != nil {
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	databaseRuntime, err := StartDatabase(runContext, DatabaseStartupOptions{
		Target: databasePath, DriverName: "sqlite", AllowCreate: true, LockTimeout: 500 * time.Millisecond,
		AuthorizedRoots: []string{dataDir}, AuthorizeStoredProjectWorkspaces: true, Readiness: readiness,
	})
	if err != nil {
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	if err := manager.Add(databaseRuntime); err != nil {
		_ = databaseRuntime.Close(context.Background())
		return daemonShutdown(manager, stderr, exitFailure)
	}
	_ = logger.Log(logging.Event{Level: "info", Code: "daemon_database_ready", Stage: "startup"})
	if applicationGate.Check(runContext) != nil {
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	connection, ok := databaseRuntime.Connection().(*storesqlite.Connection)
	if !ok {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	writer, err := storesqlite.NewWriter(storesqlite.WriterOptions{
		Connection: connection, Readiness: applicationGate, Owner: databaseRuntime,
		AuthorizedCopy: true, SchemaVersion: storesqlite.SchemaVersion,
	})
	if err != nil {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	configuration := config.Config{
		HTTP: config.HTTP{
			ListenHost: config.DefaultListenHost, ListenPort: 0, AllowedOrigins: daemonAllowedOrigins(),
			BodyLimitBytes: config.DefaultBodyLimit, ReadHeaderTimeout: config.DefaultReadHeader,
			ReadTimeout: config.DefaultRead, WriteTimeout: config.DefaultWrite,
			IdleTimeout: config.DefaultIdle, ShutdownTimeout: config.DefaultShutdown,
		},
		Runtime: config.Runtime{Directory: dataDir, TargetKind: config.RuntimeTargetTemporary}, LogLevel: config.LogInfo,
	}
	mcpConfiguration := mcp.DefaultConfig()
	mcpConfiguration.Enabled = features.GoMCPAPI
	if portText := strings.TrimSpace(os.Getenv("AUTOPLAN_MCP_PORT")); portText != "" {
		if port, parseErr := strconv.Atoi(portText); parseErr == nil && port > 0 && port <= 65535 && strconv.Itoa(port) == portText {
			mcpConfiguration.Port = port
			mcpConfiguration.PortExplicit = true
		}
	}
	mcpConfiguration.AllowedOrigins = append([]string(nil), configuration.HTTP.AllowedOrigins...)
	terminalConfiguration := config.DefaultTerminalRuntime()
	terminalAccess := newRepositoryTerminalAccess(writer)
	loopState := storesqlite.NewLoopStateStore(writer)
	processConfiguration := config.DefaultProcessRuntime()
	processRunner, err := processruntime.NewRunner(processruntime.Dependencies{
		Config: processConfiguration, Policy: terminalAccess,
		BaseEnvironment: loopProcessEnvironment(processConfiguration.AllowedEnvironment),
	})
	if err != nil {
		_ = readiness.MarkFailed("application", "process_runner_failed")
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	if err := manager.Add(runtimelifecycle.CloserFunc(func(context.Context) error {
		processRunner.Shutdown()
		return nil
	})); err != nil {
		processRunner.Shutdown()
		return daemonShutdown(manager, stderr, exitFailure)
	}
	dependencies, err := AssembleDependencies(configuration, DependencyOverrides{
		Clock: clock, Readiness: applicationGate, Repository: writer, ProjectWriter: writer,
		Logger: applicationLogger{logger: logger, clock: clock}, Random: bytes.NewReader(sessionRaw), MCPConfig: &mcpConfiguration,
		TerminalRuntime: &terminalConfiguration, TerminalPolicy: terminalAccess,
		TerminalAuthorizer: terminalAccess, TerminalWorkspace: terminalAccess,
		OperationProjects: terminalAccess, LoopState: loopState,
		ScriptRunner: processRunner, ScriptFiles: terminalAccess, ScriptFinalizer: sqliteScriptFinalizer{writer: writer},
		LoopRunner: sidecarLoopRunner{
			store: repositoryLoopCycleStore{writer: writer, projects: writer}, runner: processRunner,
			stateStore: loopState, logger: logger,
		},
	})
	if err != nil || dependencies.Services.Ready(runContext) != nil {
		_ = readiness.MarkFailed("application", "dependency_failed")
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	if recoveryStore, ok := dependencies.Repository.(applicationruntime.ProcessRecoveryStore); ok {
		if _, err := applicationruntime.RecoverProcessOwnership(
			runContext,
			applicationruntime.NewOwnershipRegistry(),
			recoveryStore,
			applicationruntime.DefaultProcessRecoveryInput(clock.Now()),
		); err != nil {
			_ = readiness.MarkFailed("application", "process_recovery_failed")
			_ = dependencies.Close(context.Background())
			return daemonShutdown(manager, stderr, exitBlocked)
		}
	}
	if err := dependencies.RecoverOperations(runContext); err != nil {
		_ = readiness.MarkFailed("application", "operation_recovery_failed")
		_ = dependencies.Close(context.Background())
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	_ = logger.Log(logging.Event{Level: "info", Code: "daemon_recovery_completed", Stage: "startup"})
	if err := manager.Add(dependencies); err != nil {
		_ = dependencies.Close(context.Background())
		return daemonShutdown(manager, stderr, exitFailure)
	}
	// MCP failures remain isolated to the independently gated transport. The
	// status records a fail-closed error and the daemon never falls back to the
	// legacy Node MCP server or opens another listener.
	_ = dependencies.StartMCP(runContext)
	_ = readiness.MarkReady("application")

	router, err := httpapi.NewRouter(httpapi.RouterOptions{
		Application: dependencies.Application, Logger: logger, Clock: clock,
		BodyLimitBytes: config.DefaultBodyLimit,
	})
	securityPolicy, securityErr := dependencies.NewHTTPSecurity(logger, clock)
	if err != nil || securityErr != nil || httpapi.RegisterProbes(router, readiness, securityPolicy) != nil ||
		dependencies.RegisterRuntimeRoutes(router, logger, clock) != nil ||
		dependencies.RegisterTerminalRoutes(router, logger, clock, features.GoTerminalAPI, terminalConfiguration) != nil {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	httpServer, err := configuration.HTTP.NewServer(router)
	if err != nil {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	httpServer.ErrorLog = logging.StandardLogger(logger, clock)
	if err := manager.Add(runtimelifecycle.CloserFunc(httpServer.Shutdown)); err != nil {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	listener, err := configuration.HTTP.ListenSidecar()
	if err != nil {
		_ = readiness.MarkFailed("listener", "listen_failed")
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address == nil || address.IP == nil || !address.IP.Equal(net.ParseIP(config.DefaultListenHost)) || address.Port <= 0 {
		_ = listener.Close()
		_ = readiness.MarkFailed("listener", "listen_failed")
		return daemonShutdown(manager, stderr, exitFailure)
	}
	serveResult := make(chan error, 1)
	go func() { serveResult <- httpServer.Serve(listener) }()
	select {
	case <-runContext.Done():
		return daemonShutdown(manager, stderr, exitBlocked)
	case serveErr := <-serveResult:
		if !errors.Is(serveErr, http.ErrServerClosed) {
			_ = readiness.MarkFailed("listener", "serve_failed")
		}
		return daemonShutdown(manager, stderr, exitFailure)
	default:
	}
	if runContext.Err() != nil {
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	_ = readiness.MarkReady("listener")
	if !readiness.Ready() {
		return daemonShutdown(manager, stderr, exitBlocked)
	}
	message := daemonReadinessMessage{
		Version: daemonReadinessVersion, Type: daemonReadinessType, PID: os.Getpid(),
		Host: config.DefaultListenHost, Port: address.Port, Ready: true, Lock: "held",
		SessionProof: daemonSessionProof(sessionText, os.Getpid(), address.Port),
	}
	if err := json.NewEncoder(stdout).Encode(message); err != nil {
		return daemonShutdown(manager, stderr, exitFailure)
	}
	_ = logger.Log(logging.Event{Level: "info", Code: "daemon_ready", Stage: "startup"})

	select {
	case <-runContext.Done():
	case serveErr := <-serveResult:
		if !errors.Is(serveErr, http.ErrServerClosed) {
			_ = readiness.MarkFailed("listener", "serve_failed")
			return daemonShutdown(manager, stderr, exitFailure)
		}
	}
	return daemonShutdown(manager, stderr, exitOK)
}

func daemonAllowedOrigins() []string {
	origins := []string{daemonOrigin}
	rendererOrigin := strings.TrimSpace(os.Getenv("AUTOPLAN_SIDECAR_RENDERER_ORIGIN"))
	parsed, err := url.Parse(rendererOrigin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Hostname() != config.DefaultListenHost || parsed.Port() == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return origins
	}
	canonical := parsed.Scheme + "://" + parsed.Host
	if canonical != daemonOrigin {
		origins = append(origins, canonical)
	}
	return origins
}

// RunMCPStdioCommand uses the same dependency assembly and immutable tool
// registry as the daemon but never opens a database, HTTP listener, or hidden
// writer. stdout is reserved for protocol frames by Server.ServeStdio.
func RunMCPStdioCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		return mcpStdioFailure(stderr, exitUsage)
	}
	features, err := config.RuntimeFeaturesFromEnvironment(os.Environ())
	if err != nil || !features.GoMCPAPI {
		return mcpStdioFailure(stderr, exitBlocked)
	}
	clock := backendruntime.SystemClock{}
	mcpConfiguration := mcp.DefaultConfig()
	mcpConfiguration.Enabled = true
	mcpConfiguration.Transport = mcp.TransportStdio
	dependencies, err := AssembleDependencies(config.Defaults(), DependencyOverrides{
		Clock: clock, Repository: skeletonRepository{},
		Logger: applicationLogger{logger: logging.Nop{}, clock: clock}, MCPConfig: &mcpConfiguration,
	})
	if err != nil || dependencies.MCP == nil {
		return mcpStdioFailure(stderr, exitBlocked)
	}
	defer dependencies.Close(context.Background())
	if err := dependencies.MCP.ServeStdio(ctx, stdin, stdout, stderr); err != nil && !errors.Is(err, context.Canceled) {
		return mcpStdioFailure(stderr, exitBlocked)
	}
	return exitOK
}

func mcpStdioFailure(stderr io.Writer, code int) int {
	if stderr != nil {
		_, _ = io.WriteString(stderr, "autoplan mcp unavailable\n")
	}
	return code
}

func parseDaemonOptions(args []string) (daemonOptions, error) {
	if len(args) != 2 || args[0] != "--data-dir" || strings.TrimSpace(args[1]) == "" || strings.TrimSpace(args[1]) != args[1] {
		return daemonOptions{}, errors.New("daemon arguments invalid")
	}
	return daemonOptions{DataDir: args[1]}, nil
}

func readDaemonSession(input io.Reader) (string, []byte, *bufio.Reader, error) {
	if input == nil {
		return "", nil, nil, errors.New("daemon session unavailable")
	}
	reader := bufio.NewReaderSize(input, daemonMaxSessionInput+1)
	content, err := reader.ReadSlice('\n')
	if err != nil || len(content) <= 1 || len(content) > daemonMaxSessionInput || reader.Buffered() != 0 {
		return "", nil, nil, errors.New("daemon session invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(content)))
	decoder.DisallowUnknownFields()
	var message daemonSessionMessage
	if err := decoder.Decode(&message); err != nil {
		return "", nil, nil, errors.New("daemon session invalid")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || message.Version != daemonReadinessVersion || message.Type != daemonSessionType || !validDaemonSession(message.Session) {
		return "", nil, nil, errors.New("daemon session invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(message.Session)
	if err != nil || len(raw) != daemonSessionBytes {
		zeroDaemonBytes(raw)
		return "", nil, nil, errors.New("daemon session invalid")
	}
	return message.Session, raw, reader, nil
}

// Electron keeps stdin open after the one-line session handoff. EOF is the
// parent-death signal: a crash, forced quit, or supervisor shutdown cancels
// the daemon context before a stale sidecar can retain the database lock.
func watchDaemonParent(input io.Reader, cancel context.CancelFunc) {
	if input == nil || cancel == nil {
		return
	}
	go func() {
		buffer := make([]byte, 1)
		for {
			count, err := input.Read(buffer)
			if count > 0 || err != nil {
				zeroDaemonBytes(buffer)
				cancel()
				return
			}
		}
	}()
}

func validateDaemonDataDirectory(value string) (string, string, error) {
	if !filepath.IsAbs(value) {
		return "", "", errors.New("daemon data directory invalid")
	}
	info, err := os.Lstat(value)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", errors.New("daemon data directory invalid")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(value))
	if err != nil || !allowedDaemonDataDirectory(resolved) {
		return "", "", errors.New("daemon data directory invalid")
	}
	return resolved, filepath.Join(resolved, "autoplan.sqlite"), nil
}

func allowedDaemonDataDirectory(resolved string) bool {
	explicit := strings.TrimSpace(os.Getenv("AUTOPLAN_SIDECAR_DATA_DIR"))
	if filepath.IsAbs(explicit) {
		explicitResolved, err := filepath.EvalSymlinks(filepath.Clean(explicit))
		if err == nil && sameDaemonDirectory(resolved, explicitResolved) {
			return true
		}
	}
	if withinDaemonDirectory(resolved, os.TempDir()) {
		return true
	}
	userConfig, err := os.UserConfigDir()
	return err == nil && withinDaemonDirectory(resolved, userConfig)
}

func sameDaemonDirectory(left, right string) bool {
	if goruntime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func verifyMigratedDatabase(databasePath string) error {
	info, err := os.Lstat(databasePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("daemon migration pending")
	}
	file, err := os.Open(databasePath)
	if err != nil {
		return errors.New("daemon migration pending")
	}
	defer file.Close()
	header := make([]byte, 100)
	if _, err := io.ReadFull(file, header); err != nil || string(header[:16]) != "SQLite format 3\x00" ||
		binary.BigEndian.Uint32(header[60:64]) != migrations.SchemaV3UserVersion {
		return errors.New("daemon migration pending")
	}
	return nil
}

func daemonSessionProof(session string, pid, port int) string {
	mac := hmac.New(sha256.New, []byte(session))
	_, _ = mac.Write([]byte("autoplan-daemon-ready-v1\x00" + strconv.Itoa(pid) + "\x00" + strconv.Itoa(port)))
	return hex.EncodeToString(mac.Sum(nil))
}

func validDaemonSession(value string) bool {
	if len(value) != daemonSessionLength {
		return false
	}
	for _, character := range value {
		if !(character >= 'A' && character <= 'Z') && !(character >= 'a' && character <= 'z') &&
			!(character >= '0' && character <= '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func daemonShutdown(manager *runtimelifecycle.Manager, stderr io.Writer, code int) int {
	if manager == nil || manager.Shutdown() != nil {
		return daemonFailure(stderr, exitFailure)
	}
	return code
}

func daemonFailure(stderr io.Writer, code int) int {
	if stderr != nil {
		_, _ = io.WriteString(stderr, "autoplan daemon unavailable\n")
	}
	return code
}

func withinDaemonDirectory(target, root string) bool {
	rootResolved, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(rootResolved, target)
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func zeroDaemonBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
