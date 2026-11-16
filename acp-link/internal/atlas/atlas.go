// Package atlas wraps the team's multi-repo tool (Atlas) behind configurable
// command templates, and runs check commands. The Atlas CLI syntax is not
// fixed yet, so everything is template driven:
//
//	locate_cmd   once per task; stdout lines "group/project [local path]"
//	prepare_cmd  per repo when it contains {repo}, else once; must leave a
//	             worktree at {workspace} on branch {branch}
//	check_cmd    per repo when it contains {repo}, else once; exit 0 = pass
//
// Commands are split into argv (shell-like quoting) and executed directly,
// never through a shell, so placeholder values cannot inject commands.
package atlas

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"

	"acp/acp-link/internal/config"
)

// Vars are the placeholder values.
type Vars struct {
	TaskID    string
	Branch    string
	Repo      string
	Workspace string
}

func (v Vars) replacer() *strings.Replacer {
	return strings.NewReplacer("{task_id}", v.TaskID, "{branch}", v.Branch, "{repo}", v.Repo, "{workspace}", v.Workspace)
}

// Split tokenizes a command line. Single quotes are literal, double quotes
// group words and allow \" and \\ escapes; outside quotes a backslash only
// escapes a following quote, space or backslash (so C:\tools\x.exe works).
func Split(s string) ([]string, error) {
	var (
		args  []string
		cur   strings.Builder
		inArg bool
		quote rune
	)
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case quote == '\'':
			if r == '\'' {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case quote == '"':
			switch {
			case r == '"':
				quote = 0
			case r == '\\' && i+1 < len(rs) && (rs[i+1] == '"' || rs[i+1] == '\\'):
				i++
				cur.WriteRune(rs[i])
			default:
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			inArg = true
		case r == '\\' && i+1 < len(rs) && (rs[i+1] == '"' || rs[i+1] == '\'' || rs[i+1] == ' ' || rs[i+1] == '\\'):
			i++
			cur.WriteRune(rs[i])
			inArg = true
		case unicode.IsSpace(r):
			if inArg {
				args = append(args, cur.String())
				cur.Reset()
				inArg = false
			}
		default:
			cur.WriteRune(r)
			inArg = true
		}
	}
	if quote != 0 {
		return nil, fmt.Errorf("命令 %q 中引号未闭合", s)
	}
	if inArg {
		args = append(args, cur.String())
	}
	return args, nil
}

// Render splits template and substitutes placeholders inside each argument.
func Render(template string, v Vars) ([]string, error) {
	args, err := Split(template)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		return nil, errors.New("命令为空")
	}
	r := v.replacer()
	for i := range args {
		args[i] = r.Replace(args[i])
	}
	return args, nil
}

// PerRepo reports whether a template should run once per repository.
func PerRepo(template string) bool { return strings.Contains(template, "{repo}") }

// Result is the outcome of one command.
type Result struct {
	Args     []string
	Dir      string
	Stdout   string
	Stderr   string
	ExitCode int
	Duration time.Duration
	Err      error
}

// OK reports success.
func (r Result) OK() bool { return r.Err == nil && r.ExitCode == 0 }

// Summary is a short one-line description for progress messages.
func (r Result) Summary() string {
	out := strings.TrimSpace(r.Stderr)
	if out == "" {
		out = strings.TrimSpace(r.Stdout)
	}
	out = lastLines(out, 8)
	status := "通过"
	if !r.OK() {
		status = fmt.Sprintf("失败（退出码 %d）", r.ExitCode)
		if r.Err != nil && r.ExitCode == 0 {
			status = "失败：" + r.Err.Error()
		}
	}
	s := fmt.Sprintf("`%s` %s，耗时 %s", strings.Join(r.Args, " "), status, r.Duration.Round(time.Second))
	if !r.OK() && out != "" {
		s += "\n" + out
	}
	return s
}

func lastLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	out := strings.Join(lines, "\n")
	if len(out) > 2000 {
		out = "…" + out[len(out)-2000:]
	}
	return out
}

// Run executes argv in dir with env (nil = inherit) and a timeout.
func Run(ctx context.Context, args []string, dir string, env []string, timeout time.Duration) Result {
	res := Result{Args: args, Dir: dir}
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	cmd := exec.CommandContext(cctx, args[0], args[1:]...)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	cmd.WaitDelay = 5 * time.Second
	var so, se bytes.Buffer
	cmd.Stdout = &limitedBuffer{b: &so, max: 1 << 20}
	cmd.Stderr = &limitedBuffer{b: &se, max: 1 << 20}
	err := cmd.Run()
	res.Duration = time.Since(start)
	res.Stdout, res.Stderr = so.String(), se.String()
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) || cctx.Err() != nil {
			res.Err = err
			if cctx.Err() == context.DeadlineExceeded {
				res.Err = fmt.Errorf("超时（%s）", timeout)
			}
			if res.ExitCode == 0 {
				res.ExitCode = -1
			}
		}
	}
	return res
}

type limitedBuffer struct {
	b   *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

// Atlas executes the configured templates.
type Atlas struct {
	Cfg     config.Atlas
	Env     []string
	Timeout time.Duration
}

// Enabled reports whether Atlas is switched on.
func (a *Atlas) Enabled() bool { return a != nil && a.Cfg.Enabled }

// Located is one repo reported by locate_cmd.
type Located struct {
	Name string
	Path string
}

// Locate runs locate_cmd and parses "group/project [path]" lines. repos are
// the task's repos (joined with "," into {repo}). With no locate_cmd it returns nil.
func (a *Atlas) Locate(ctx context.Context, v Vars, dir string) ([]Located, Result, error) {
	if !a.Enabled() || strings.TrimSpace(a.Cfg.LocateCmd) == "" {
		return nil, Result{}, nil
	}
	args, err := Render(a.Cfg.LocateCmd, v)
	if err != nil {
		return nil, Result{}, err
	}
	res := Run(ctx, args, dir, a.Env, a.Timeout)
	if !res.OK() {
		return nil, res, fmt.Errorf("atlas locate 失败: %s", res.Summary())
	}
	return ParseLocate(res.Stdout), res, nil
}

// ParseLocate parses locate output; blank lines and lines starting with # are skipped.
func ParseLocate(out string) []Located {
	var list []Located
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, path := line, ""
		if i := strings.IndexFunc(line, unicode.IsSpace); i > 0 {
			name, path = line[:i], strings.TrimSpace(line[i:])
		}
		name = strings.Trim(name, "/")
		if seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		list = append(list, Located{Name: name, Path: path})
	}
	return list
}

// Prepare runs prepare_cmd for one repo (v.Workspace = target worktree path).
func (a *Atlas) Prepare(ctx context.Context, v Vars, dir string) (Result, error) {
	args, err := Render(a.Cfg.PrepareCmd, v)
	if err != nil {
		return Result{}, err
	}
	res := Run(ctx, args, dir, a.Env, a.Timeout)
	if !res.OK() {
		return res, fmt.Errorf("atlas prepare 失败: %s", res.Summary())
	}
	return res, nil
}

// HasPrepare reports whether Atlas prepares worktrees.
func (a *Atlas) HasPrepare() bool { return a.Enabled() && strings.TrimSpace(a.Cfg.PrepareCmd) != "" }

// HasCheck reports whether Atlas runs checks.
func (a *Atlas) HasCheck() bool { return a.Enabled() && strings.TrimSpace(a.Cfg.CheckCmd) != "" }

// Check runs check_cmd.
func (a *Atlas) Check(ctx context.Context, v Vars, dir string) (Result, error) {
	args, err := Render(a.Cfg.CheckCmd, v)
	if err != nil {
		return Result{}, err
	}
	return Run(ctx, args, dir, a.Env, a.Timeout), nil
}
