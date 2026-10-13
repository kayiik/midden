package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// kernelModel answers like an OpenAI-compatible model for the real kernel:
// a turn whose text asks for a tool calls exec once, a "slow" turn waits, a
// "TEXTONLY" turn is refused while tools are offered, and anything else
// answers at once. system returns the last system prompt it was sent.
func kernelModel(t *testing.T) (server *httptest.Server, system func() string) {
	t.Helper()
	var (
		mu     sync.Mutex
		prompt string
	)
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"object":"list","data":[{"id":"fixture","object":"model"}]}`)
			return
		}
		var request struct {
			Messages []map[string]any `json:"messages"`
			Stream   bool             `json:"stream"`
			Tools    []any            `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		if len(request.Messages) > 0 && request.Messages[0]["role"] == "system" {
			mu.Lock()
			prompt = fmt.Sprint(request.Messages[0]["content"])
			mu.Unlock()
		}
		last := 0
		for i, message := range request.Messages {
			if message["role"] == "user" {
				last = i
			}
		}
		user, results := fmt.Sprint(request.Messages[last]["content"]), []string{}
		for _, message := range request.Messages[last:] {
			if message["role"] == "tool" {
				results = append(results, fmt.Sprint(message["content"]))
			}
		}
		if strings.Contains(user, "TEXTONLY") && len(request.Tools) > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"This model does not support tools.","type":"invalid_request_error"}}`)
			return
		}
		if strings.Contains(user, "slow") {
			select {
			case <-time.After(20 * time.Second):
			case <-r.Context().Done():
				return
			}
		}
		message := map[string]any{"role": "assistant", "content": "Plain answer."}
		finish := "stop"
		toolCall := func(id, name string, arguments map[string]any) {
			raw, _ := json.Marshal(arguments)
			message = map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": id, "type": "function", "index": 0,
				"function": map[string]any{"name": name, "arguments": string(raw)}}}}
			finish = "tool_calls"
		}
		asks := len(results) == 0 && len(request.Tools) > 0
		_, path, reads := strings.Cut(user, "READ:")
		switch {
		case strings.Contains(user, "LATER-REMINDER"):
			message["content"] = "Reminder done."
		case strings.Contains(user, "NOTE") && asks:
			toolCall("call-note", "message", map[string]any{"content": "Working on it."})
		case strings.Contains(user, "NOTE"):
			message["content"] = "Noted and done."
		case strings.Contains(user, "LATER") && asks:
			toolCall("call-cron", "cron", map[string]any{"action": "add", "at_seconds": 2, "message": "LATER-REMINDER"})
		case strings.Contains(user, "LATER"):
			message["content"] = "Scheduled."
		case reads && asks:
			toolCall("call-read", "read_file", map[string]any{"path": strings.TrimSpace(path)})
		case strings.Contains(user, "tool") && asks:
			toolCall("call-1", "exec", map[string]any{"action": "run", "command": "echo kernel-check"})
		case len(results) > 0:
			message["content"] = "Tool said: " + strings.TrimSpace(results[0])
		}
		choice := map[string]any{"index": 0, "finish_reason": finish}
		if request.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			choice["delta"] = message
			raw, _ := json.Marshal(map[string]any{"choices": []any{choice}})
			fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", raw)
			return
		}
		choice["message"] = message
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{choice}})
	}))
	t.Cleanup(server.Close)
	return server, func() string {
		mu.Lock()
		defer mu.Unlock()
		return prompt
	}
}

func TestTheAppDrivesTheRealKernel(t *testing.T) {
	executable := os.Getenv("MIDDEN_TEST_KERNEL")
	if executable == "" {
		t.Skip("set MIDDEN_TEST_KERNEL to a compa-kernel 0.0.1 executable to run the App against it")
	}
	model, system := kernelModel(t)
	opts := testOptions(t)
	opts.Kernel, opts.KernelVersion = executable, "0.0.1"
	opts.Skills = filepath.Join(t.TempDir(), "skills")
	writeTestFile(t, filepath.Join(opts.Skills, "midden-check", "SKILL.md"), "---\nname: midden-check\ndescription: Use when checking.\n---\n# Check\n")
	app, err := NewApp(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	storeTestModel(t, app, model.URL+"/v1", "")
	// The person's own policy asks before exec, so the approval relay runs.
	cfg, err := loadKernelConfig(app.paths.Kernel)
	if err != nil {
		t.Fatal(err)
	}
	cfg.other["tools"] = json.RawMessage(`{"approval":{"rules":[{"tool":"exec","action":"ask"}]}}`)
	if err := saveKernelConfig(app.paths.Kernel, cfg); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIDDEN_UI_TEST_KERNEL_HOOK", "1")
	setup := app.kernelSetup(os.Args[0])
	setup.Hook = []string{os.Args[0]}
	kernel, err := newKernelProcess(setup)
	if err != nil {
		t.Fatal(err)
	}
	app.attachKernel(kernel)
	kernel.Start()
	ctx, cancel := context.WithTimeout(context.Background(), kernelStartTimeout)
	defer cancel()
	if err := kernel.waitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if reported := kernel.reportedVersion(); reported != "0.0.1" {
		t.Fatalf("the kernel's pid file names version %q", reported)
	}
	events := watchEvents(app)

	s, _ := app.NewSession("real kernel")
	if _, err := app.StartTurn(s.ID, "please run a tool"); err != nil {
		t.Fatal(err)
	}
	asked := waitEvent(t, events, func(e Event) bool { return e.Type == "permission" })
	if asked.Tool != "exec" {
		t.Fatalf("permission = %+v", asked)
	}
	if err := app.Decide(asked.PermissionID, true); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "tool" && e.Status == "completed" && e.Tool == "exec" })
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
	session, _ := app.Session(s.ID)
	if session.Outcomes[0].Status != "completed" || !strings.Contains(session.Messages[len(session.Messages)-1].Content, "kernel-check") {
		t.Fatalf("tool turn = %+v %+v", session.Outcomes, session.Messages)
	}
	// The kernel introduces the agent with AGENT.md's name and description,
	// once.
	if prompt := system(); !strings.Contains(prompt, "You are Midden, the Midden App's assistant: you investigate recorded AI sessions") ||
		strings.Count(prompt, "You are Midden") != 1 {
		t.Fatalf("system prompt = %q", prompt)
	}

	if _, err := app.StartTurn(s.ID, "slow question"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	app.mu.Lock()
	turn := app.active.ID
	app.mu.Unlock()
	stopped := time.Now()
	if err := app.Cancel(turn); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" && e.TurnID == turn })
	if elapsed := time.Since(stopped); elapsed > 10*time.Second {
		t.Fatalf("stopping took %s", elapsed)
	}
	if session, _ = app.Session(s.ID); session.Outcomes[1].Status != "cancelled" {
		t.Fatalf("stopped turn = %+v", session.Outcomes[1])
	}

	if err := app.setDefaultModel(context.Background(), "fixture/fixture"); err != nil {
		t.Fatalf("a model change did not reach the kernel: %v", err)
	}
	if _, err := app.StartTurn(s.ID, "plain question"); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
	if session, _ = app.Session(s.ID); session.Outcomes[2].Status != "completed" || session.Messages[len(session.Messages)-1].Content != "Plain answer." {
		t.Fatalf("turn after reload = %+v", session.Outcomes[2])
	}
	// Stopping a turn left no reply of its own behind.
	if len(session.Messages) != 5 {
		t.Fatalf("messages after the stopped turn = %+v", session.Messages)
	}
	// The agent requires tools: a model that refuses them fails the turn
	// instead of answering without them.
	if _, err := app.StartTurn(s.ID, "TEXTONLY question"); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
	if session, _ = app.Session(s.ID); session.Outcomes[3].Status != "failed" || !strings.Contains(session.Outcomes[3].Error, "requires them") ||
		session.Messages[len(session.Messages)-1].Content == "Plain answer." {
		t.Fatalf("turn with a model that refuses tools = %+v, last message %+v", session.Outcomes[3], session.Messages[len(session.Messages)-1])
	}
	// The agent reads the installed skills, but not the kernel's own settings.
	read := func(path string) string {
		t.Helper()
		if _, err := app.StartTurn(s.ID, "please READ:"+path); err != nil {
			t.Fatal(err)
		}
		waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
		session, _ := app.Session(s.ID)
		return session.Messages[len(session.Messages)-1].Content
	}
	if answer := read(filepath.Join(opts.Skills, "midden-check", "SKILL.md")); !strings.Contains(answer, "name: midden-check") {
		t.Fatalf("the agent could not read an installed skill: %q", answer)
	}
	if answer := read(kernelConfigPath(app.paths.Kernel)); strings.Contains(answer, "provider_instances") {
		t.Fatalf("the agent read the kernel's settings: %q", answer)
	}
	if text := readTestFile(t, filepath.Join(app.paths.Workspace, "AGENT.md")); !strings.Contains(text, "name: Midden") {
		t.Fatal("the kernel's workspace lacks Midden's instructions")
	}
	// What the message tool sends during a turn stays in the turn's reply.
	if _, err := app.StartTurn(s.ID, "please NOTE this"); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
	if session, _ = app.Session(s.ID); session.Messages[len(session.Messages)-1].Content != "Working on it.\n\nNoted and done." {
		t.Fatalf("reply with a note = %q", session.Messages[len(session.Messages)-1].Content)
	}
	// A reply the kernel gives later on its own, here a scheduled task's,
	// joins the conversation.
	if _, err := app.StartTurn(s.ID, "remind me LATER"); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, events, func(e Event) bool { return e.Type == "turn_done" })
	deadline := time.After(30 * time.Second)
	for later := false; !later; {
		select {
		case e := <-events:
			later = e.Type == "reply" && e.SessionID == s.ID
		case <-deadline:
			t.Fatal("the scheduled task's reply did not reach the conversation")
		}
	}
	if session, _ = app.Session(s.ID); session.Messages[len(session.Messages)-1].Content != "Reminder done." {
		t.Fatalf("scheduled reply = %q", session.Messages[len(session.Messages)-1].Content)
	}
	// Deleting the conversation removes the record the real kernel kept of it.
	chatRecords := func() []string {
		names, _ := filepath.Glob(filepath.Join(app.paths.Workspace, "sessions", "*.meta.json"))
		matching := []string{}
		for _, name := range names {
			if strings.Contains(readTestFile(t, name), `"direct:web:`+s.ID+`"`) {
				matching = append(matching, name)
			}
		}
		return matching
	}
	if len(chatRecords()) == 0 {
		t.Fatal("the kernel kept no record of the conversation")
	}
	if err := app.DeleteSession(s.ID); err != nil {
		t.Fatal(err)
	}
	if left := chatRecords(); len(left) != 0 {
		t.Fatalf("the kernel's record of the deleted conversation remains: %v", left)
	}
	app.Close()
	if _, err := readKernelPid(app.paths.Kernel); !os.IsNotExist(err) {
		t.Fatalf("the kernel did not stop with the App: %v", err)
	}
}
