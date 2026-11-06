# Performance budget and load test

The sizing statement in the README (about 500 users, tens of thousands of entities, 2 to 3 API pods and 2 worker
pods) is backed by a reproducible load test. This page describes the profile, the scenarios, the budgets, and how to
run it.

## Profile

| Dimension           | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Catalog             | 100,000 entities over 20 blueprints, 2 relations each (`dependsOn`), 10 teams        |
| Interactive users   | 500 concurrent browsing users (think time 3 to 8 s), plus 100 searching users        |
| Self-service runs   | 1,000 runs per hour, each with an approval step and a catalog write                  |
| Bulk ingestion      | 1 call per second of 200 entities (an integration sync running continuously)         |
| Webhook fan-out     | 2 subscribers, 10 changed entities per second for 60 s, delivery measured at a sink |
| Reference topology  | 2 API pods + 2 worker pods (100m CPU / 256 Mi), PostgreSQL 2 vCPU / 4 GB             |

The synthetic data is deterministic (`apps/server/src/loadtest/seed-data.ts`, covered by unit tests).

## Budgets

Defined in [`loadtest/budget.json`](../loadtest/budget.json) and enforced as k6 thresholds: when one is crossed, k6
exits non-zero and the nightly job fails.

| Measure                                              | Budget (p95)  |
| ---------------------------------------------------- | ------------- |
| Catalog browse (home, list, filter)                  | 400 ms        |
| Entity detail and relations                          | 300 ms        |
| Search (`/entities?search=`)                         | 600 ms        |
| Run trigger (`POST /actions/:id/runs`)               | 500 ms        |
| Run completion after approval                        | 30 s          |
| Bulk ingest of 200 entities                          | 8 s           |
| Event to outbound webhook delivery                   | 60 s (max)    |
| Failed requests / failed checks                      | below 1%      |

These are initial values chosen for the reference topology, not yet measured results. After the first nightly runs,
tighten them to about 1.3 times the observed p95 so that real regressions trip the job. Never raise a budget to make a
regression pass: fix the regression or record the decision in the change that moves it.

## Run it

Prerequisites: [k6](https://k6.io/docs/get-started/installation/), a platform on PostgreSQL with local registration
enabled (`AUTH_PROVIDERS=local ALLOW_REGISTRATION=true`) and at least one worker.

```bash
npm run loadtest:sink &                                     # webhook sink on :9099
BASE_URL=http://localhost:8080 ENTITIES=100000 npm run --silent loadtest:seed 2>/dev/null | grep ^TOKEN= > /tmp/lt.env
. /tmp/lt.env
k6 run -e BASE_URL=http://localhost:8080 -e TOKEN=$TOKEN -e SINK_URL=http://localhost:9099 loadtest/k6/scenarios.js
```

Useful variables: `SCENARIOS=browse,search` to run a subset (`browse,search,runs,ingest,fanout`), `USERS`,
`DURATION`, `ENTITIES` (must match the seed), `SINK_PUBLIC_URL` when the platform reaches the sink at another address
than k6 does. Seeding is idempotent; the 100,000 entities take a few minutes.

The platform limits requests per client IP (`trustProxy`). The scenarios send a distinct `X-Forwarded-For` per virtual
user, as separate users would have; run the platform behind the same proxy settings as production, not with a
firewall that rewrites that header.

## Reading the results

- k6 prints the custom trends (`catalog_browse_ms`, `catalog_search_ms`, `entity_detail_ms`, `run_trigger_ms`,
  `run_completion_s`, `bulk_ingest_ms`, `webhook_delivery_ms`) with their thresholds; the CI job uploads
  `k6-summary.json` and the platform logs.
- Cross-check on the server side with `asterius_http_request_duration_seconds` (per route),
  `asterius_db_pool_waiting_requests` (above 0 means the pool is the bottleneck: raise `database.poolSize`),
  `asterius_queue_oldest_run_age_seconds` and `asterius_queue_oldest_delivery_age_seconds` (workers not keeping up),
  and `asterius_webhook_delivery_latency_seconds`. The Grafana dashboard shipped with the chart shows all of them.
- Delivery throughput is bounded by the delivery loop (20 deliveries per tick, 3 s tick, per worker pod). Add worker
  replicas before raising fan-out.

## Nightly job

[`.github/workflows/loadtest.yml`](../.github/workflows/loadtest.yml) starts PostgreSQL, the built platform
(`PLATFORM_ROLE=all`) and the sink, seeds, runs k6 and uploads the summary. Trigger it by hand with
`workflow_dispatch` to try a different size or duration. A single-process runner is smaller than the reference
topology: a budget that fails there but passes on the reference topology means the budget is too tight for the CI
runner, in which case scale the profile down with `USERS` and `ENTITIES`, not the budget.
