// Package workspace owns the on-disk layout of task workspaces, branch and
// directory naming, and the ACP_TASK.md context file.
package workspace

import (
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// MaxSlugLen bounds the summary part of a branch name.
const MaxSlugLen = 40

// TaskKey is the display key ACP-<id>.
func TaskKey(id int64) string { return "ACP-" + strconv.FormatInt(id, 10) }

// Slug derives an ASCII summary from a title: lower-case letters and digits,
// words joined by "-", at most MaxSlugLen characters. Non-ASCII text (e.g.
// Chinese) is dropped; a title without any ASCII word yields "task".
func Slug(title string) string {
	var words []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			words = append(words, cur.String())
			cur.Reset()
		}
	}
	for _, r := range title {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			cur.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			cur.WriteRune(r + ('a' - 'A'))
		default:
			flush()
		}
	}
	flush()
	var out strings.Builder
	for _, w := range words {
		need := len(w)
		if out.Len() > 0 {
			need++
		}
		if out.Len()+need > MaxSlugLen {
			if out.Len() == 0 { // single very long word
				out.WriteString(w[:MaxSlugLen])
			}
			break
		}
		if out.Len() > 0 {
			out.WriteByte('-')
		}
		out.WriteString(w)
	}
	if out.Len() == 0 {
		return "task"
	}
	return out.String()
}

// BranchName returns acp/<id>-<slug>.
func BranchName(id int64, title string) string {
	return fmt.Sprintf("acp/%d-%s", id, Slug(title))
}

var repoSegment = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.\-]*$`)

// ValidRepoName checks a GitLab project path such as "group/sub/project".
// It rejects anything that could escape a directory (.., absolute paths, etc.).
func ValidRepoName(name string) bool {
	if name == "" || len(name) > 255 || strings.ContainsAny(name, "\\:") {
		return false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == "." || seg == ".." || !repoSegment.MatchString(seg) {
			return false
		}
	}
	return true
}

// NormalizeRepo trims spaces and surrounding slashes and a trailing ".git".
func NormalizeRepo(name string) string {
	name = strings.Trim(strings.TrimSpace(name), "/")
	return strings.TrimSuffix(name, ".git")
}

// RepoDirNames assigns each repo a unique, filesystem-safe directory name:
// the project name, or the full path joined by "-" when two repos share it.
func RepoDirNames(repos []string) map[string]string {
	count := map[string]int{}
	for _, r := range repos {
		count[strings.ToLower(path.Base(r))]++
	}
	out := make(map[string]string, len(repos))
	used := map[string]bool{}
	for _, r := range repos {
		name := path.Base(r)
		if count[strings.ToLower(name)] > 1 {
			name = strings.ReplaceAll(r, "/", "-")
		}
		base := name
		for i := 2; used[strings.ToLower(name)]; i++ {
			name = fmt.Sprintf("%s-%d", base, i)
		}
		used[strings.ToLower(name)] = true
		out[r] = name
	}
	return out
}

// Layout is the workspace directory structure:
//
//	<root>/<id>/ACP_TASK.md          context for the agent (agent cwd = <root>/<id>)
//	<root>/<id>/<repo-dir>/          git worktree per repository
//	<root>/.private/<id>/mcp.json    task token for the agent (0600, deleted after the run)
type Layout struct{ Root string }

// TaskDir is the agent's working directory.
func (l Layout) TaskDir(id int64) string { return filepath.Join(l.Root, strconv.FormatInt(id, 10)) }

// RepoDir is the worktree path for a repo directory name.
func (l Layout) RepoDir(id int64, dir string) string { return filepath.Join(l.TaskDir(id), dir) }

// ContextFile is ACP_TASK.md.
func (l Layout) ContextFile(id int64) string { return filepath.Join(l.TaskDir(id), ContextFileName) }

// PrivateDir holds secrets for one task, outside the agent's cwd.
func (l Layout) PrivateDir(id int64) string {
	return filepath.Join(l.Root, ".private", strconv.FormatInt(id, 10))
}

// MCPConfigFile is the per-task MCP config.
func (l Layout) MCPConfigFile(id int64) string { return filepath.Join(l.PrivateDir(id), "mcp.json") }
