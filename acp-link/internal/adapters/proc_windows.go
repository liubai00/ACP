//go:build windows

package adapters

import (
	"os"
	"os/exec"
	"strconv"
	"time"
)

func setProcAttr(cmd *exec.Cmd) {}

// killTree kills the process and all of its children (claude.cmd -> node.exe ...).
func killTree(p *os.Process) error {
	if p == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.Pid))
	done := make(chan error, 1)
	if err := kill.Start(); err == nil {
		go func() { done <- kill.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = kill.Process.Kill()
		}
	}
	_ = p.Kill()
	return nil
}
