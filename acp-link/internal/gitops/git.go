// Package gitops runs the git operations acp-link performs on behalf of the
// developer: fetch, worktrees, commit and push with GitLab push options. It
// uses the developer's own git configuration and credentials; the coding
// agent never gets them.
package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Git runs git commands.
type Git struct {
	Bin     string
	Env     []string // nil = inherit
	Timeout time.Duration
}

// New returns a Git using "git" from PATH.
func New() *Git {
	return &Git{Bin: "git", Timeout: 5 * time.Minute}
}

// Error carries git's output.
type Error struct {
	Args   []string
	Output string
	Err    error
}

func (e *Error) Error() string {
	out := strings.TrimSpace(e.Output)
	if len(out) > 1500 {
		out = "…" + out[len(out)-1500:]
	}
	return fmt.Sprintf("git %s: %v: %s", strings.Join(e.Args, " "), e.Err, out)
}

// Run executes git in dir and returns combined stdout (stderr is included in errors).
func (g *Git) Run(ctx context.Context, dir string, args ...string) (string, error) {
	out, _, err := g.run(ctx, dir, args...)
	return out, err
}

func (g *Git) run(ctx context.Context, dir string, args ...string) (stdout, stderr string, err error) {
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, g.Bin, args...)
	cmd.Dir = dir
	env := g.Env
	if env == nil {
		env = os.Environ()
	}
	// Never block on an interactive prompt in daemon mode.
	cmd.Env = append(append([]string(nil), env...), "GIT_TERMINAL_PROMPT=0")
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err = cmd.Run()
	if err != nil {
		if cctx.Err() == context.DeadlineExceeded {
			err = fmt.Errorf("timeout after %s", timeout)
		}
		return so.String(), se.String(), &Error{Args: args, Output: se.String() + so.String(), Err: err}
	}
	return so.String(), se.String(), nil
}

// Version returns `git --version`.
func (g *Git) Version(ctx context.Context) (string, error) {
	out, err := g.Run(ctx, "", "--version")
	return strings.TrimSpace(out), err
}

// IsRepo reports whether dir is inside a git work tree.
func (g *Git) IsRepo(ctx context.Context, dir string) bool {
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return false
	}
	out, err := g.Run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

// TopLevel returns the work tree root of dir.
func (g *Git) TopLevel(ctx context.Context, dir string) (string, error) {
	out, err := g.Run(ctx, dir, "rev-parse", "--show-toplevel")
	return filepath.Clean(strings.TrimSpace(out)), err
}

// RemoteURL returns the URL of remote.
func (g *Git) RemoteURL(ctx context.Context, dir, remote string) (string, error) {
	out, err := g.Run(ctx, dir, "remote", "get-url", remote)
	return strings.TrimSpace(out), err
}

// Identity returns user.name and user.email as git resolves them in dir.
func (g *Git) Identity(ctx context.Context, dir string) (name, email string) {
	n, _ := g.Run(ctx, dir, "config", "user.name")
	e, _ := g.Run(ctx, dir, "config", "user.email")
	return strings.TrimSpace(n), strings.TrimSpace(e)
}

// Fetch fetches remote (prunes deleted branches).
func (g *Git) Fetch(ctx context.Context, repo, remote string) error {
	_, err := g.Run(ctx, repo, "fetch", "--prune", remote)
	return err
}

// RefExists reports whether a ref resolves to a commit.
func (g *Git) RefExists(ctx context.Context, dir, ref string) bool {
	_, err := g.Run(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}

// FindTaskBranch returns an existing acp/<id>-* branch (remote first, then
// local), or "" when there is none or the choice is ambiguous.
func (g *Git) FindTaskBranch(ctx context.Context, repo, remote string, id int64) string {
	prefix := fmt.Sprintf("acp/%d-", id)
	for _, ns := range []string{"refs/remotes/" + remote + "/", "refs/heads/"} {
		out, err := g.Run(ctx, repo, "for-each-ref", "--format=%(refname)", ns+prefix+"*")
		if err != nil {
			continue
		}
		var found []string
		for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				found = append(found, strings.TrimPrefix(l, ns))
			}
		}
		if len(found) == 1 {
			return found[0]
		}
		if len(found) > 1 {
			return ""
		}
	}
	return ""
}

// Head returns the current commit.
func (g *Git) Head(ctx context.Context, dir string) (string, error) {
	out, err := g.Run(ctx, dir, "rev-parse", "HEAD")
	return strings.TrimSpace(out), err
}

// WorktreeResult describes how a worktree was prepared.
type WorktreeResult struct {
	Path   string
	Branch string
	Base   string // ref the branch was created from / compared against
	Reused bool   // an existing (kept) worktree was reused
	Mode   string // "reused", "remote-branch", "local-branch", "new"
}

// PrepareWorktree creates (or reuses) the task worktree at path for branch.
//
//  1. path already is a worktree on branch -> reuse (e.g. kept after a failed run)
//  2. <remote>/<branch> exists -> continue from the pushed task branch
//  3. local branch exists      -> attach it
//  4. otherwise                -> new branch from <remote>/<target>
func (g *Git) PrepareWorktree(ctx context.Context, repo, path, branch, remote, target string) (*WorktreeResult, error) {
	res := &WorktreeResult{Path: path, Branch: branch}
	remoteBranch := remote + "/" + branch
	remoteTarget := remote + "/" + target
	if g.RefExists(ctx, repo, "refs/remotes/"+remoteBranch) {
		res.Base = remoteBranch
	} else {
		res.Base = remoteTarget
	}
	if _, err := os.Stat(path); err == nil {
		if top, err := g.TopLevel(ctx, path); err == nil && samePath(top, path) {
			cur, _ := g.Run(ctx, path, "rev-parse", "--abbrev-ref", "HEAD")
			if strings.TrimSpace(cur) == branch {
				res.Reused, res.Mode = true, "reused"
				return res, nil
			}
		}
		entries, _ := os.ReadDir(path)
		if len(entries) > 0 {
			return nil, fmt.Errorf("工作区目录 %s 已存在且不是分支 %s 的工作区，请手动清理后重试", path, branch)
		}
		_ = os.Remove(path)
	}
	_, _ = g.Run(ctx, repo, "worktree", "prune")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	var err error
	switch {
	case res.Base == remoteBranch:
		res.Mode = "remote-branch"
		_, err = g.Run(ctx, repo, "worktree", "add", "-B", branch, path, remoteBranch)
	case g.RefExists(ctx, repo, "refs/heads/"+branch):
		res.Mode = "local-branch"
		_, err = g.Run(ctx, repo, "worktree", "add", path, branch)
	default:
		if !g.RefExists(ctx, repo, remoteTarget) {
			return nil, fmt.Errorf("目标分支 %s 不存在（检查 git.remote / target_branch 配置）", remoteTarget)
		}
		res.Mode = "new"
		_, err = g.Run(ctx, repo, "worktree", "add", "--no-track", "-b", branch, path, remoteTarget)
	}
	if err != nil {
		return nil, err
	}
	return res, nil
}

// Status returns `git status --porcelain` output.
func (g *Git) Status(ctx context.Context, dir string) (string, error) {
	return g.Run(ctx, dir, "status", "--porcelain")
}

// Dirty reports uncommitted changes (including untracked files).
func (g *Git) Dirty(ctx context.Context, dir string) (bool, error) {
	out, err := g.Status(ctx, dir)
	return strings.TrimSpace(out) != "", err
}

// Ahead counts commits in HEAD that are not in base.
func (g *Git) Ahead(ctx context.Context, dir, base string) (int, error) {
	out, err := g.Run(ctx, dir, "rev-list", "--count", base+"..HEAD")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(out))
}

// StageAll runs `git add -A`.
func (g *Git) StageAll(ctx context.Context, dir string) error {
	_, err := g.Run(ctx, dir, "add", "-A")
	return err
}

// HasStaged reports whether the index differs from HEAD.
func (g *Git) HasStaged(ctx context.Context, dir string) (bool, error) {
	_, err := g.Run(ctx, dir, "diff", "--cached", "--quiet")
	if err == nil {
		return false, nil
	}
	var ge *Error
	if errors.As(err, &ge) {
		var ee *exec.ExitError
		if errors.As(ge.Err, &ee) && ee.ExitCode() == 1 {
			return true, nil
		}
	}
	return false, err
}

// CommitStaged commits the index with the developer's identity and hooks.
func (g *Git) CommitStaged(ctx context.Context, dir, message string) error {
	_, err := g.Run(ctx, dir, "commit", "-m", message)
	if err != nil && strings.Contains(err.Error(), "Please tell me who you are") {
		return fmt.Errorf("git 未配置提交身份，请运行 git config --global user.name/user.email: %w", err)
	}
	return err
}

// CommitAll stages everything and commits with the developer's identity.
func (g *Git) CommitAll(ctx context.Context, dir, message string) error {
	if _, err := g.Run(ctx, dir, "add", "-A"); err != nil {
		return err
	}
	_, err := g.Run(ctx, dir, "commit", "-m", message)
	if err != nil && strings.Contains(err.Error(), "Please tell me who you are") {
		return fmt.Errorf("git 未配置提交身份，请运行 git config --global user.name/user.email: %w", err)
	}
	return err
}

// PushOptions configures Push.
type PushOptions struct {
	Remote   string
	Branch   string
	CreateMR bool
	Target   string
	Title    string
}

// PushResult is the outcome of Push.
type PushResult struct {
	Output         string
	MRURL          string
	UsedMROptions  bool
	FallbackReason string
}

// Push pushes HEAD to refs/heads/<branch>. With CreateMR it adds GitLab push
// options; if the remote does not support push options it retries without
// them (the branch is still pushed, but no MR is created).
func (g *Git) Push(ctx context.Context, dir string, o PushOptions) (*PushResult, error) {
	refspec := "HEAD:refs/heads/" + o.Branch
	args := []string{"push", "--porcelain"}
	if o.CreateMR {
		args = append(args,
			"-o", "merge_request.create",
			"-o", "merge_request.target="+o.Target,
			"-o", "merge_request.title="+oneLine(o.Title),
			"-o", "merge_request.remove_source_branch",
		)
	}
	args = append(args, o.Remote, refspec)
	so, se, err := g.run(ctx, dir, args...)
	res := &PushResult{Output: se + so, UsedMROptions: o.CreateMR}
	if err != nil && o.CreateMR {
		// Most often: the remote does not advertise push options (not GitLab,
		// or a plain bare repo). Retry once without them; real failures
		// (auth, non-fast-forward) fail again and are reported.
		if strings.Contains(strings.ToLower(se), "push option") {
			res.FallbackReason = "远端不支持 push options，已普通推送（未自动创建 MR）"
		} else {
			res.FallbackReason = "带 MR 选项推送失败，已改为普通推送（未自动创建 MR）"
		}
		res.UsedMROptions = false
		so, se, err = g.run(ctx, dir, "push", "--porcelain", o.Remote, refspec)
		res.Output = se + so
	}
	if err != nil {
		return res, err
	}
	res.MRURL = ParseMRURL(res.Output)
	return res, nil
}

// RemoveWorktree removes a worktree. repo may be "" (derived from the worktree's common dir).
func (g *Git) RemoveWorktree(ctx context.Context, repo, path string) error {
	if repo == "" {
		out, err := g.Run(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return err
		}
		common := filepath.Clean(strings.TrimSpace(out))
		if filepath.Base(common) == ".git" {
			repo = filepath.Dir(common)
		} else {
			repo = common
		}
	}
	if _, err := g.Run(ctx, repo, "worktree", "remove", "--force", path); err != nil {
		if _, statErr := os.Stat(path); errors.Is(statErr, os.ErrNotExist) {
			_, _ = g.Run(ctx, repo, "worktree", "prune")
			return nil
		}
		return err
	}
	return nil
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

var mrURLRe = regexp.MustCompile(`https?://[^\s'"<>]+/merge_requests/\d+`)

// ParseMRURL finds the merge request URL in git push output (GitLab prints
// "View merge request for <branch>:" followed by the URL). "merge_requests/new"
// links (MR not created) are ignored.
func ParseMRURL(output string) string {
	m := mrURLRe.FindAllString(output, -1)
	if len(m) == 0 {
		return ""
	}
	return strings.TrimRight(m[len(m)-1], ".,;)")
}
