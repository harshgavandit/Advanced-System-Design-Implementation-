package main

import (
	"errors"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/adaptor"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type appMetrics struct {
	implementation string
	requests       *prometheus.CounterVec
	duration       *prometheus.HistogramVec
	inFlight       *prometheus.GaugeVec
	scrape         fiber.Handler
}

func newAppMetrics(implementation string) *appMetrics {
	registry := prometheus.NewRegistry()
	requests := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "app_http_requests_total",
		Help: "Completed application HTTP requests",
	}, []string{"implementation", "method", "route", "status_code"})
	duration := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "app_http_request_duration_seconds",
		Help:    "Application HTTP request duration in seconds",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	}, []string{"implementation", "method", "route", "status_code"})
	inFlight := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "app_http_requests_in_flight",
		Help: "Application HTTP requests currently being handled",
	}, []string{"implementation"})

	registry.MustRegister(
		prometheus.NewGoCollector(),
		prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
		requests,
		duration,
		inFlight,
	)

	return &appMetrics{
		implementation: implementation,
		requests:       requests,
		duration:       duration,
		inFlight:       inFlight,
		scrape:         adaptor.HTTPHandler(promhttp.HandlerFor(registry, promhttp.HandlerOpts{})),
	}
}

func metricStatus(c *fiber.Ctx, err error) int {
	if err == nil {
		return c.Response().StatusCode()
	}
	var fiberErr *fiber.Error
	if errors.As(err, &fiberErr) {
		return fiberErr.Code
	}
	return fiber.StatusInternalServerError
}

func metricRoute(c *fiber.Ctx, status int) string {
	if status == fiber.StatusNotFound {
		return "__unmatched__"
	}
	route := c.Route().Path
	if route == "" || route == "*" {
		return "__unmatched__"
	}
	return route
}

func (m *appMetrics) middleware(c *fiber.Ctx) error {
	if c.Path() == "/metrics" {
		return c.Next()
	}

	m.inFlight.WithLabelValues(m.implementation).Inc()
	defer m.inFlight.WithLabelValues(m.implementation).Dec()
	startedAt := time.Now()
	err := c.Next()
	status := metricStatus(c, err)
	labels := []string{m.implementation, c.Method(), metricRoute(c, status), strconv.Itoa(status)}
	m.requests.WithLabelValues(labels...).Inc()
	m.duration.WithLabelValues(labels...).Observe(time.Since(startedAt).Seconds())
	return err
}

func (m *appMetrics) handler(c *fiber.Ctx) error {
	return m.scrape(c)
}
