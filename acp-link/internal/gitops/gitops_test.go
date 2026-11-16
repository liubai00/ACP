package gitops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseMRURL(t *testing.T) {
	cases := map[string]string{
		"push_gitlab_new_mr.txt":      "https://gitlab.example.com/group/demo/-/merge_requests/17",
		"push_gitlab_no_mr.txt":       "",
		"push_gitlab_existing_mr.txt": "http://10.0.0.5:8080/client/sub/app/merge_requests/5",
	}
	for f, want := range cases {
		b, err := os.ReadFile(filepath.Join("testdata", f))
		if err != nil {
			t.Fatal(err)
		}
		if got := ParseMRURL(string(b)); got != want {
			t.Errorf("%s: got %q want %q", f, got, want)
		}
	}
	if ParseMRURL("To /tmp/remote.git\n * [new branch] HEAD -> acp/1-x\n") != "" {
		t.Error("plain push output has no MR")
	}
}

// IsolateGit points git at an empty global config so tests do not depend on
// (or modify) the developer's settings.
func IsolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	empty := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(empty, []byte("[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", empty)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// NewRepoWithRemote creates bare remote + clone with one commit on main.
func newRepoWithRemote(t *testing.T) (clone, bare string) {
	t.Helper()
	root := t.TempDir()
	bare = filepath.Join(root, "remote.git")
	clone = filepath.Join(root, "clone")
	git(t, root, "init", "--bare", "-b", "main", bare)
	git(t, root, "clone", bare, clone)
	git(t, clone, "config", "user.name", "Dev One")
	git(t, clone, "config", "user.email", "dev1@example.com")
	git(t, clone, "checkout", "-b", "main")
	if err := os.WriteFile(filepath.Join(clone, "README.md"), []byte("demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, clone, "add", "-A")
	git(t, clone, "commit", "-m", "init")
	git(t, clone, "push", "origin", "main")
	git(t, clone, "fetch", "origin")
	return clone, bare
}

func TestWorktreeCommitPush(t *testing.T) {
	IsolateGit(t)
	ctx := context.Background()
	clone, bare := newRepoWithRemote(t)
	g := New()
	ws := filepath.Join(t.TempDir(), "ws", "7", "demo")
	branch := "acp/7-add-thing"

	wt, err := g.PrepareWorktree(ctx, clone, ws, branch, "origin", "main")
	if err != nil {
		t.Fatal(err)
	}
	if wt.Mode != "new" || wt.Base != "origin/main" {
		t.Fatalf("worktree: %+v", wt)
	}
	if cur := git(t, ws, "rev-parse", "--abbrev-ref", "HEAD"); cur != branch {
		t.Fatalf("worktree on %q", cur)
	}
	// Reuse when it already exists on the branch.
	wt2, err := g.PrepareWorktree(ctx, clone, ws, branch, "origin", "main")
	if err != nil || !wt2.Reused {
		t.Fatalf("reuse: %+v %v", wt2, err)
	}

	if dirty, _ := g.Dirty(ctx, ws); dirty {
		t.Fatal("fresh worktree should be clean")
	}
	_ = os.WriteFile(filepath.Join(ws, "thing.txt"), []byte("x\n"), 0o644)
	if err := g.StageAll(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if staged, err := g.HasStaged(ctx, ws); err != nil || !staged {
		t.Fatalf("staged: %v %v", staged, err)
	}
	// A file created after staging (e.g. by a check) stays out of the commit.
	_ = os.WriteFile(filepath.Join(ws, "coverage.out"), []byte("c\n"), 0o644)
	if err := g.CommitStaged(ctx, ws, "ACP-7: Add thing"); err != nil {
		t.Fatal(err)
	}
	if n, _ := g.Ahead(ctx, ws, "origin/main"); n != 1 {
		t.Fatalf("ahead = %d", n)
	}
	if author := git(t, ws, "log", "-1", "--format=%an <%ae>|%s"); author != "Dev One <dev1@example.com>|ACP-7: Add thing" {
		t.Errorf("commit identity/message: %q", author)
	}
	if files := git(t, ws, "show", "--name-only", "--format=", "HEAD"); files != "thing.txt" {
		t.Errorf("committed files: %q", files)
	}

	// Plain bare remote: push options are not advertised -> fallback, no MR.
	res, err := g.Push(ctx, ws, PushOptions{Remote: "origin", Branch: branch, CreateMR: true, Target: "main", Title: "ACP-7 Add thing"})
	if err != nil {
		t.Fatal(err)
	}
	if res.UsedMROptions || res.FallbackReason == "" || res.MRURL != "" {
		t.Errorf("fallback expected: %+v", res)
	}
	if got := git(t, bare, "log", "-1", "--format=%s", branch); got != "ACP-7: Add thing" {
		t.Errorf("remote branch head: %q", got)
	}

	// Remote that accepts push options: they are sent and ignored.
	git(t, bare, "config", "receive.advertisePushOptions", "true")
	_ = os.WriteFile(filepath.Join(ws, "thing.txt"), []byte("y\n"), 0o644)
	_ = g.StageAll(ctx, ws)
	_ = g.CommitStaged(ctx, ws, "ACP-7: Add thing")
	res, err = g.Push(ctx, ws, PushOptions{Remote: "origin", Branch: branch, CreateMR: true, Target: "main", Title: "ACP-7 Add thing"})
	if err != nil || !res.UsedMROptions || res.FallbackReason != "" {
		t.Fatalf("push with options: %+v %v", res, err)
	}

	// Remove and re-create from the pushed remote branch (re-delivery).
	if err := g.RemoveWorktree(ctx, "", ws); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Fatal("worktree dir still exists")
	}
	if err := g.Fetch(ctx, clone, "origin"); err != nil {
		t.Fatal(err)
	}
	if b := g.FindTaskBranch(ctx, clone, "origin", 7); b != branch {
		t.Fatalf("FindTaskBranch = %q", b)
	}
	if b := g.FindTaskBranch(ctx, clone, "origin", 70); b != "" {
		t.Fatalf("FindTaskBranch for another id = %q", b)
	}
	wt3, err := g.PrepareWorktree(ctx, clone, ws, branch, "origin", "main")
	if err != nil {
		t.Fatal(err)
	}
	if wt3.Mode != "remote-branch" || wt3.Base != "origin/"+branch {
		t.Fatalf("re-delivery worktree: %+v", wt3)
	}
	if n, _ := g.Ahead(ctx, ws, wt3.Base); n != 0 {
		t.Fatalf("continuing branch should start level with remote, ahead=%d", n)
	}
	if _, err := os.Stat(filepath.Join(ws, "thing.txt")); err != nil {
		t.Fatal("previous work missing from continued branch")
	}
	if err := g.RemoveWorktree(ctx, clone, ws); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareWorktreeErrors(t *testing.T) {
	IsolateGit(t)
	ctx := context.Background()
	clone, _ := newRepoWithRemote(t)
	g := New()
	if _, err := g.PrepareWorktree(ctx, clone, filepath.Join(t.TempDir(), "x"), "acp/1-x", "origin", "nope"); err == nil {
		t.Fatal("missing target branch should fail")
	}
	busy := t.TempDir()
	_ = os.WriteFile(filepath.Join(busy, "junk"), []byte("x"), 0o644)
	if _, err := g.PrepareWorktree(ctx, clone, busy, "acp/1-x", "origin", "main"); err == nil {
		t.Fatal("non-empty foreign directory should fail")
	}
	if !g.IsRepo(ctx, clone) || g.IsRepo(ctx, t.TempDir()) {
		t.Fatal("IsRepo")
	}
	name, email := g.Identity(ctx, clone)
	if name != "Dev One" || email != "dev1@example.com" {
		t.Fatalf("identity %q %q", name, email)
	}
}
