# Ask AI — Benchmark Results

_Generated 2026-11-08T12:01:24.969Z by `eval/report.ts` from 604 recorded (scenario, trial, agent) row(s)._

## Pass rate — optimized agent

| Category | pass^1 | pass^3 |
|---|---|---|
| ambiguous | 85.7% (6/7) | 85.7% (6/7) |
| conditional | 50.0% (3/6) | 50.0% (3/6) |
| direct | 84.6% (66/78) | 74.4% (58/78) |
| failure | 25.0% (2/8) | 25.0% (2/8) |
| followup | 37.5% (6/16) | 31.3% (5/16) |
| indirect | 20.0% (1/5) | 20.0% (1/5) |
| multistep | 56.3% (9/16) | 50.0% (8/16) |
| unsupported | 93.3% (14/15) | 86.7% (13/15) |

## Pass rate — baseline agent

| Category | pass^1 |
|---|---|
| ambiguous | 0.0% (0/7) |
| conditional | 16.7% (1/6) |
| direct | 74.4% (58/78) |
| failure | 12.5% (1/8) |
| followup | 0.0% (0/16) |
| indirect | 20.0% (1/5) |
| multistep | 25.0% (4/16) |
| unsupported | 86.7% (13/15) |

## Latency — optimized agent (direct vs complex, LLD §9.2/docs/TARGETS.md §1 bucketing)

| Bucket | n | TTFUR p50 | TTFUR p95 | E2E p50 | E2E p95 |
|---|---|---|---|---|---|
| direct | 319 | 2004ms | 7001ms | 3808ms | 12506ms |
| complex | 191 | 2073ms | 3595ms | 7992ms | 19440ms |

## Latency — baseline agent

| Bucket | n | TTFUR p50 | TTFUR p95 | E2E p50 | E2E p95 |
|---|---|---|---|---|---|
| direct | 117 | 2211ms | 4790ms | 4028ms | 8222ms |
| complex | 53 | 2030ms | 3587ms | 7926ms | 18261ms |

## Tokens + cost — optimized agent

| Requests | avg tokens in | avg tokens out | avg cost/request | cost/successful task (incl. failed attempts) | cost among successful runs only |
|---|---|---|---|---|---|
| 510 | 87376 | 431 | $0.0252 | $0.0394 | $0.0246 |

## Tokens + cost — baseline agent

| Requests | avg tokens in | avg tokens out | avg cost/request | cost/successful task (incl. failed attempts) | cost among successful runs only |
|---|---|---|---|---|---|
| 170 | 43516 | 273 | $0.0449 | $0.0978 | $0.0401 |

## docs/TARGETS.md comparison

| Metric | Target | Actual | Status |
|---|---|---|---|
| Direct TTFUR p50 | < 2000ms | 2004ms | MISSED |
| Direct TTFUR p95 | < 4000ms | 7001ms | MISSED |
| Complex TTFUR p50 | < 4000ms | 2073ms | MET |
| Complex E2E p50 | < 12000ms | 7992ms | MET |
| Complex E2E p95 | < 25000ms | 19440ms | MET |
| Optimized task success (pass^1) | >= 85.0% | 70.9% | MISSED |
| Optimized vs baseline delta | >= +15pp | +19.2pp | MET |
| Cost per successful task, incl. failed attempts (optimized) | < $0.0100 | $0.0394 | MISSED |
| Repair-rate on complex turns (assumption, not a gate) | < 35.0% | 0.0% | MET |


_Targets were pre-committed in `docs/TARGETS.md` before any benchmark run — see that file for definitions and measurement conditions._
