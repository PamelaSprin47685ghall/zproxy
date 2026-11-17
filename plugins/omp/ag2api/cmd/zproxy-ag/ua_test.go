package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/api"
)

func TestPrepareReturnsOfficialUserAgent(t *testing.T) {
	handler := &worker{cache: api.NewZProxyCache()}
	request := `{"version":1,"request":{"model":"friendly","messages":[{"role":"user","content":"hi"}]},"model":{"id":"fixture","modelProvider":"MODEL_PROVIDER_GOOGLE","maxOutputTokens":1024,"maxTokens":8192},"project":"project","session":"session"}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "http://private/prepare", strings.NewReader(request)))
	if response.Code != http.StatusOK { t.Fatalf("prepare status: %d", response.Code) }
	var prepared struct { UserAgent string `json:"userAgent"` }
	if err := json.Unmarshal(response.Body.Bytes(), &prepared); err != nil { t.Fatal(err) }
	want := (antigravity.Device{OS: runtime.GOOS, Arch: runtime.GOARCH}).UserAgent()
	if prepared.UserAgent != want { t.Fatalf("prepare UA: %q, want %q", prepared.UserAgent, want) }
}

func TestDeviceFactoryUsesOfficialDeviceAndAgent(t *testing.T) {
	handler := &worker{cache: api.NewZProxyCache()}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "http://private/device", strings.NewReader(`{"version":1,"email":"Fixture9@example.invalid"}`)))
	if response.Code != http.StatusOK { t.Fatalf("device status: %d", response.Code) }
	var generated struct { Device antigravity.Device `json:"device"`; UserAgent string `json:"userAgent"` }
	if err := json.Unmarshal(response.Body.Bytes(), &generated); err != nil { t.Fatal(err) }
	if generated.Device.OS != runtime.GOOS || generated.Device.Arch != runtime.GOARCH || generated.Device.UserName != "Fixture9" || generated.Device.InstallationID == "" { t.Fatal("invalid official device") }
	if generated.UserAgent != generated.Device.UserAgent() { t.Fatal("device and UA disagree") }
	data, err := json.Marshal(map[string]any{"version": 1, "os": generated.Device.OS, "arch": generated.Device.Arch})
	if err != nil { t.Fatal(err) }
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "http://private/agent", strings.NewReader(string(data))))
	var agent struct { UserAgent string `json:"userAgent"` }
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &agent) != nil || agent.UserAgent != generated.UserAgent { t.Fatal("agent differs from official device") }
}
