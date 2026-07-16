package plans

import (
	"strings"
	"unicode"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
)

// ResolvePlanTitle reads a plan through the same workspace-confined path used
// by ReadContent. Read failures are deliberately collapsed to the stable
// display fallback so filesystem details never leak through projections.
func ResolvePlanTitle(workspace string, plan domainplan.Plan) string {
	fallback := "Plan #" + decimal(plan.ID)
	markdown, code, err := readWorkspacePlan(workspace, plan.SourceRef)
	if err != nil || code != "" {
		return fallback
	}
	if title := extractMarkdownTitle(markdown); title != "" {
		return title
	}
	return fallback
}

// extractMarkdownTitle implements the ATX heading subset used by plan files.
// A level-one heading wins even if a lower-level heading appears before it.
func extractMarkdownTitle(markdown string) string {
	var first string
	inFence := false
	var fenceMarker byte
	var fenceLength int
	for _, line := range strings.Split(strings.TrimPrefix(markdown, "\ufeff"), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if marker, length, ok := markdownFence(line); ok {
			if !inFence {
				inFence, fenceMarker, fenceLength = true, marker, length
			} else if marker == fenceMarker && length >= fenceLength && fenceHasNoInfo(line, marker, length) {
				inFence = false
			}
			continue
		}
		if inFence {
			continue
		}
		level, title := markdownATXHeading(line)
		if title == "" {
			continue
		}
		if level == 1 {
			return title
		}
		if first == "" {
			first = title
		}
	}
	return first
}

func markdownATXHeading(line string) (int, string) {
	line = trimMarkdownIndent(line)
	if line == "" || line[0] != '#' {
		return 0, ""
	}
	level := 0
	for level < len(line) && line[level] == '#' {
		level++
	}
	if level > 6 || (level < len(line) && line[level] != ' ' && line[level] != '\t') {
		return 0, ""
	}
	return level, cleanPlanTitle(strings.TrimLeft(line[level:], " \t"))
}

func cleanPlanTitle(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	// A closing ATX sequence is syntax only when separated from the title by
	// whitespace. This keeps legitimate titles such as "C#" unchanged.
	end := len(value)
	for end > 0 && value[end-1] == '#' {
		end--
	}
	if end == 0 {
		return ""
	}
	if end < len(value) && (value[end-1] == ' ' || value[end-1] == '\t') {
		value = strings.TrimSpace(value[:end])
	}
	if value == "" {
		return ""
	}
	for _, character := range value {
		if unicode.IsControl(character) && !unicode.IsSpace(character) {
			return ""
		}
	}
	return strings.Join(strings.Fields(value), " ")
}

func trimMarkdownIndent(line string) string {
	spaces := 0
	for spaces < len(line) && spaces < 3 && line[spaces] == ' ' {
		spaces++
	}
	return line[spaces:]
}

func markdownFence(line string) (byte, int, bool) {
	line = trimMarkdownIndent(line)
	if len(line) < 3 || (line[0] != '`' && line[0] != '~') {
		return 0, 0, false
	}
	marker := line[0]
	length := 0
	for length < len(line) && line[length] == marker {
		length++
	}
	if length < 3 {
		return 0, 0, false
	}
	return marker, length, true
}

func fenceHasNoInfo(line string, marker byte, length int) bool {
	line = trimMarkdownIndent(line)
	return strings.Trim(line[length:], " \t") == ""
}
