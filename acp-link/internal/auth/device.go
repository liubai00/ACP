package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"time"

	"acp/acp-link/internal/api"
)

// DeviceLoginOptions configures DeviceLogin.
type DeviceLoginOptions struct {
	Hostname string
	Out      io.Writer
	// OpenBrowser is called with the verification URL; nil disables it.
	OpenBrowser func(url string) error
	// MinInterval floors the poll interval. When the server sends no
	// interval (0) it is also used instead of the 5s default (tests).
	MinInterval time.Duration
	// SlowDownStep is added to the interval on "slow_down" (default 5s, RFC 8628).
	SlowDownStep time.Duration
}

// DeviceLogin runs the device authorization flow and returns credentials.
func DeviceLogin(ctx context.Context, c *api.Client, o DeviceLoginOptions) (*Credentials, error) {
	out := o.Out
	if out == nil {
		out = io.Discard
	}
	dc, err := c.DeviceCode(ctx, "acp-link", o.Hostname)
	if err != nil {
		return nil, fmt.Errorf("申请设备码失败: %w", err)
	}
	link := dc.VerificationURIComplete
	if link == "" {
		link = dc.VerificationURI
	}
	fmt.Fprintf(out, "\n请在浏览器打开：%s\n", link)
	if dc.VerificationURI != "" && dc.VerificationURI != link {
		fmt.Fprintf(out, "（或打开 %s 手动输入）\n", dc.VerificationURI)
	}
	fmt.Fprintf(out, "确认码：%s\n\n", dc.UserCode)
	if o.OpenBrowser != nil && link != "" {
		if err := o.OpenBrowser(link); err != nil {
			fmt.Fprintf(out, "未能自动打开浏览器（%v），请手动复制上面的地址。\n", err)
		}
	}
	fmt.Fprintln(out, "等待在浏览器中确认…")

	interval := time.Duration(dc.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
		if o.MinInterval > 0 {
			interval = o.MinInterval
		}
	}
	slowDown := o.SlowDownStep
	if slowDown <= 0 {
		slowDown = 5 * time.Second
	}
	if o.MinInterval > 0 && interval < o.MinInterval {
		interval = o.MinInterval
	}
	expires := time.Now().Add(15 * time.Minute)
	if dc.ExpiresIn > 0 {
		expires = time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	}
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
		if time.Now().After(expires) {
			return nil, errors.New("设备码已过期，请重新运行 acp-link login")
		}
		tok, err := c.DeviceToken(ctx, dc.DeviceCode)
		switch {
		case err == nil:
			now := time.Now()
			fallback := now.Add(7 * 24 * time.Hour)
			if tok.ExpiresIn > 0 {
				fallback = now.Add(time.Duration(tok.ExpiresIn) * time.Second)
			}
			typ := tok.TokenType
			if typ == "" {
				typ = "Bearer"
			}
			return &Credentials{
				Server:      c.BaseURL,
				AccessToken: tok.AccessToken,
				TokenType:   typ,
				ExpiresAt:   ExpiryOf(tok.AccessToken, fallback),
				MemberID:    tok.Member.ID,
				MemberName:  tok.Member.Name,
				ObtainedAt:  now,
			}, nil
		case api.IsCode(err, "authorization_pending"):
			continue
		case api.IsCode(err, "slow_down"):
			interval += slowDown
			continue
		case api.IsCode(err, "expired_token"):
			return nil, errors.New("设备码已过期，请重新运行 acp-link login")
		case api.IsCode(err, "access_denied"):
			return nil, errors.New("登录请求被拒绝")
		default:
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status >= 500 {
				continue // transient server error, keep polling
			}
			if errors.As(err, &ae) {
				return nil, fmt.Errorf("换取令牌失败: %w", err)
			}
			// network error: keep polling until expiry
			fmt.Fprintf(out, "网络错误，稍后重试：%v\n", err)
		}
	}
}

// OpenBrowser opens url with the platform's default handler.
func OpenBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errors.New("没有图形界面")
		}
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func isWindows() bool { return runtime.GOOS == "windows" }
