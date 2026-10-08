package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// Integration opt-in. Reuses the real handlers and reads only the isolated
// fixture database seeded by the Phase 0 runner. Unsupported routes are absent.
func TestPhase0Contract(t *testing.T) {
	uri := os.Getenv("PHASE0_MONGO_URI")
	if uri == "" {
		t.Skip("Phase 0 integration requires explicit isolated URI")
	}
	if uri != "mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true" {
		t.Fatal("nonisolated target refused")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(context.Background())
	app := fiber.New(fiber.Config{ErrorHandler: errorHandler})
	metrics := newAppMetrics("go")
	app.Use(metrics.middleware)
	app.Get("/health", func(c *fiber.Ctx) error { return c.JSON(fiber.Map{"status": "ok"}) })
	app.Get("/metrics", metrics.handler)
	app.Get("/products", list(client.Database("phase0_contract_test").Collection("products")))
	fetch := func(path string) []byte {
		t.Helper()
		response, err := app.Test(httptest.NewRequest("GET", path, nil), 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("%s status=%d", path, response.StatusCode)
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	t.Run("getHealth", func(t *testing.T) {
		var value map[string]string
		if err := json.Unmarshal(fetch("/health"), &value); err != nil {
			t.Fatal(err)
		}
		if value["status"] != "ok" {
			t.Fatal(value)
		}
	})
	t.Run("listProducts", func(t *testing.T) {
		var page offsetResp
		if err := json.Unmarshal(fetch("/products?page=1&limit=20"), &page); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 20 || page.TotalItems != 10000 || page.Items[0].ID.Hex() != "000000000000002a00000001" {
			t.Fatalf("unexpected populated page: items=%d total=%d", len(page.Items), page.TotalItems)
		}
		var first, next cursorResp
		if err := json.Unmarshal(fetch("/products?limit=20"), &first); err != nil {
			t.Fatal(err)
		}
		if first.NextCursor == nil {
			t.Fatal("missing next cursor")
		}
		if err := json.Unmarshal(fetch("/products?limit=20&cursor="+*first.NextCursor), &next); err != nil {
			t.Fatal(err)
		}
		if len(next.Items) != 20 || next.Items[0].ID.Hex() != "000000000000002a00000015" {
			t.Fatal("incorrect cursor continuation")
		}
	})
	t.Run("getMetrics", func(t *testing.T) {
		if !strings.Contains(string(fetch("/metrics")), "app_http_requests_total") {
			t.Fatal("missing HTTP metrics")
		}
	})
	t.Log("3 supported operations verified; 23 unsupported operations are not passed tests")
}
