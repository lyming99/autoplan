package config

import "time"

const (
	DefaultProcessTimeout             = 45 * time.Minute
	DefaultProcessGracePeriod         = 5 * time.Second
	DefaultProcessStreamBytes         = 64 << 10
	DefaultProcessCombinedBytes       = 128 << 10
	DefaultProcessStreamLines         = 1024
	DefaultProcessCombinedLines       = 2048
	DefaultProcessTailBytes           = 16 << 10
	DefaultProcessPersistentTailBytes = 8 << 10
	DefaultProcessPersistentTailLines = 256
	DefaultProcessArguments           = 256
	DefaultProcessArgumentBytes       = 64 << 10
	DefaultProcessInputBytes          = 64 << 10
	DefaultProcessEnvironmentEntries  = 64
	DefaultProcessEnvironmentBytes    = 128 << 10
	DefaultProcessProjectConcurrent   = 2
	DefaultProcessGlobalConcurrent    = 8
	DefaultProcessChunkBytes          = 8 << 10
	// Recovery is bounded before the daemon accepts process work. Exceeding
	// this limit fails closed so a partial restart repair cannot hide stale
	// process ownership or create an unbounded startup transaction.
	DefaultProcessRecoveryRecords = 1000

	MaximumProcessTimeout             = 2 * time.Hour
	MaximumProcessGracePeriod         = time.Minute
	MaximumProcessStreamBytes         = 1 << 20
	MaximumProcessCombinedBytes       = 2 << 20
	MaximumProcessStreamLines         = 16384
	MaximumProcessCombinedLines       = 32768
	MaximumProcessTailBytes           = 64 << 10
	MaximumProcessPersistentTailBytes = 64 << 10
	MaximumProcessPersistentTailLines = 4096
	MaximumProcessArguments           = 1024
	MaximumProcessArgumentBytes       = 256 << 10
	MaximumProcessInputBytes          = 1 << 20
	MaximumProcessEnvironmentEntries  = 128
	MaximumProcessEnvironmentBytes    = 1 << 20
	MaximumProcessProjectConcurrent   = 64
	MaximumProcessGlobalConcurrent    = 256
	MaximumProcessChunkBytes          = 64 << 10
	MaximumProcessRecoveryRecords     = 5000
)

// ProcessRuntime holds all finite runner limits. AllowedEnvironment is an
// allowlist of names only: values are injected at process start and are never
// stored in configuration, responses, event payloads or logs.
type ProcessRuntime struct {
	DefaultTimeout         time.Duration
	GracePeriod            time.Duration
	MaxStreamBytes         int
	MaxCombinedBytes       int
	MaxStreamLines         int
	MaxCombinedLines       int
	TailBytes              int
	MaxPersistentTailBytes int
	MaxPersistentTailLines int
	MaxArguments           int
	MaxArgumentBytes       int
	MaxInputBytes          int
	MaxEnvironmentEntries  int
	MaxEnvironmentBytes    int
	MaxProjectConcurrent   int
	MaxGlobalConcurrent    int
	ReadChunkBytes         int
	AllowedEnvironment     []string
}

func DefaultProcessRuntime() ProcessRuntime {
	return ProcessRuntime{
		DefaultTimeout: DefaultProcessTimeout, GracePeriod: DefaultProcessGracePeriod,
		MaxStreamBytes: DefaultProcessStreamBytes, MaxCombinedBytes: DefaultProcessCombinedBytes,
		MaxStreamLines: DefaultProcessStreamLines, MaxCombinedLines: DefaultProcessCombinedLines,
		TailBytes:              DefaultProcessTailBytes,
		MaxPersistentTailBytes: DefaultProcessPersistentTailBytes,
		MaxPersistentTailLines: DefaultProcessPersistentTailLines,
		MaxArguments:           DefaultProcessArguments, MaxArgumentBytes: DefaultProcessArgumentBytes,
		MaxInputBytes:         DefaultProcessInputBytes,
		MaxEnvironmentEntries: DefaultProcessEnvironmentEntries,
		MaxEnvironmentBytes:   DefaultProcessEnvironmentBytes,
		MaxProjectConcurrent:  DefaultProcessProjectConcurrent,
		MaxGlobalConcurrent:   DefaultProcessGlobalConcurrent,
		ReadChunkBytes:        DefaultProcessChunkBytes,
		AllowedEnvironment:    []string{"PATH", "PATHEXT", "SystemRoot", "ComSpec", "TMP", "TEMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CODEX_HOME"},
	}
}

// Valid rejects an unbounded or internally inconsistent runner. Queueing a
// process with zero output or argument limits is never silently accepted.
func (value ProcessRuntime) Valid() bool {
	if value.DefaultTimeout <= 0 || value.DefaultTimeout > MaximumProcessTimeout ||
		value.GracePeriod <= 0 || value.GracePeriod > MaximumProcessGracePeriod ||
		value.MaxStreamBytes <= 0 || value.MaxStreamBytes > MaximumProcessStreamBytes ||
		value.MaxCombinedBytes <= 0 || value.MaxCombinedBytes > MaximumProcessCombinedBytes ||
		value.MaxCombinedBytes < value.MaxStreamBytes ||
		value.MaxStreamLines <= 0 || value.MaxStreamLines > MaximumProcessStreamLines ||
		value.MaxCombinedLines <= 0 || value.MaxCombinedLines > MaximumProcessCombinedLines ||
		value.MaxCombinedLines < value.MaxStreamLines ||
		value.TailBytes <= 0 || value.TailBytes > MaximumProcessTailBytes ||
		value.TailBytes > value.MaxStreamBytes ||
		value.MaxPersistentTailBytes <= 0 || value.MaxPersistentTailBytes > MaximumProcessPersistentTailBytes ||
		value.MaxPersistentTailBytes > value.TailBytes ||
		value.MaxPersistentTailLines <= 0 || value.MaxPersistentTailLines > MaximumProcessPersistentTailLines ||
		value.MaxPersistentTailLines > value.MaxStreamLines ||
		value.MaxArguments <= 0 || value.MaxArguments > MaximumProcessArguments ||
		value.MaxArgumentBytes <= 0 || value.MaxArgumentBytes > MaximumProcessArgumentBytes ||
		value.MaxInputBytes <= 0 || value.MaxInputBytes > MaximumProcessInputBytes ||
		value.MaxEnvironmentEntries <= 0 || value.MaxEnvironmentEntries > MaximumProcessEnvironmentEntries ||
		value.MaxEnvironmentBytes <= 0 || value.MaxEnvironmentBytes > MaximumProcessEnvironmentBytes ||
		value.MaxProjectConcurrent <= 0 || value.MaxProjectConcurrent > MaximumProcessProjectConcurrent ||
		value.MaxGlobalConcurrent <= 0 || value.MaxGlobalConcurrent > MaximumProcessGlobalConcurrent ||
		value.MaxProjectConcurrent > value.MaxGlobalConcurrent ||
		value.ReadChunkBytes <= 0 || value.ReadChunkBytes > MaximumProcessChunkBytes ||
		len(value.AllowedEnvironment) > 128 {
		return false
	}
	seen := make(map[string]struct{}, len(value.AllowedEnvironment))
	for _, name := range value.AllowedEnvironment {
		if !validEnvironmentName(name) {
			return false
		}
		if _, duplicate := seen[name]; duplicate {
			return false
		}
		seen[name] = struct{}{}
	}
	return true
}

func validEnvironmentName(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for index, character := range value {
		if index == 0 && !(character == '_' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z') {
			return false
		}
		if index > 0 && !(character == '_' || character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}
