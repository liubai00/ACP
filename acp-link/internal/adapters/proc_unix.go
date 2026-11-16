//go:build !windows

package adapters

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func setProcAttr(cmd *exec.Cmd) {
	// Own process group so the whole tree can be signalled.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree sends SIGTERM to the process group, then SIGKILL after a grace period.
func killTree(p *os.Process) error {
	if p == nil {
		return nil
	}
	pgid := -p.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	go func() {
		time.Sleep(5 * time.Second)
		_ = syscall.Kill(pgid, syscall.SIGKILL)
	}()
	return nil
}
