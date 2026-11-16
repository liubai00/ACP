package atlas

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"acp/acp-link/internal/config"
)

func TestSplit(t *testing.T) {
	cases := map[string][]string{
		`atlas prepare --task {task_id}`:            {"atlas", "prepare", "--task", "{task_id}"},
		`sh -c "npm test && npm run lint"`:          {"sh", "-c", "npm test && npm run lint"},
		`cmd /c 'echo a "b"'`:                       {"cmd", "/c", `echo a "b"`},
		`C:\tools\atlas.exe check {workspace}`:      {`C:\tools\atlas.exe`, "check", "{workspace}"},
		`"C:\Program Files\atlas\atlas.exe" locate`: {`C:\Program Files\atlas\atlas.exe`, "locate"},
		`a\ b c`:      {"a b", "c"},
		`x "" y`:      {"x", "", "y"},
		`  spaced   `: {"spaced"},
	}
	for in, want := range cases {
		got, err := Split(in)
		if err != nil {
			t.Fatalf("Split(%q): %v", in, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Split(%q) = %#v want %#v", in, got, want)
		}
	}
	if _, err := Split(`unterminated "quote`); err == nil {
		t.Error("expected error for unterminated quote")
	}
}

func TestRenderNoInjection(t *testing.T) {
	args, err := Render(`atlas prepare --repo {repo} --branch {branch} --dir {workspace}`, Vars{
		Repo: "group/x; rm -rf /", Branch: "acp/1-x", Workspace: `D:\ws\1\my app`,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"atlas", "prepare", "--repo", "group/x; rm -rf /", "--branch", "acp/1-x", "--dir", `D:\ws\1\my app`}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("got %#v", args)
	}
	if !PerRepo("x {repo}") || PerRepo("x {workspace}") {
		t.Error("PerRepo")
	}
}

func TestParseLocate(t *testing.T) {
	out := "# repos for ACP-1\nclient/app /home/u/code/app\n\nserver/api\nclient/app dup\n"
	got := ParseLocate(out)
	want := []Located{{Name: "client/app", Path: "/home/u/code/app"}, {Name: "server/api"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v", got)
	}
}

func TestRunExitCode(t *testing.T) {
	// Use the test binary itself as a portable "command".
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	res := Run(context.Background(), []string{exe, "-test.run=TestHelperProcess", "--", "fail"}, t.TempDir(), append(os.Environ(), "ATLAS_HELPER=1"), time.Minute)
	if res.OK() || res.ExitCode != 3 {
		t.Fatalf("want exit 3, got %+v", res)
	}
	if res.Summary() == "" {
		t.Error("empty summary")
	}
	res = Run(context.Background(), []string{exe, "-test.run=TestHelperProcess", "--", "ok"}, t.TempDir(), append(os.Environ(), "ATLAS_HELPER=1"), time.Minute)
	if !res.OK() {
		t.Fatalf("want ok, got %+v", res)
	}
	res = Run(context.Background(), []string{filepath.Join(t.TempDir(), "does-not-exist")}, "", nil, time.Minute)
	if res.OK() || res.Err == nil {
		t.Fatal("missing binary should fail")
	}
}

func TestLocateCommand(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	a := &Atlas{Cfg: config.Atlas{Enabled: true, LocateCmd: `"` + exe + `" -test.run=TestHelperProcess -- locate {task_id}`},
		Env: append(os.Environ(), "ATLAS_HELPER=1")}
	list, _, err := a.Locate(context.Background(), Vars{TaskID: "9"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "group/task9" {
		t.Fatalf("locate: %+v", list)
	}
	_ = runtime.GOOS
}

// TestHelperProcess is not a real test; it is executed as a child process.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("ATLAS_HELPER") != "1" {
		return
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	switch args[0] {
	case "fail":
		os.Stderr.WriteString("boom\n")
		os.Exit(3)
	case "locate":
		os.Stdout.WriteString("group/task" + args[1] + "\n")
		os.Exit(0)
	}
	os.Exit(0)
}
