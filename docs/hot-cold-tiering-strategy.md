# Technical Report: Timeseries Hot/Cold Data Tiering — On-Premise Deployment

**Document Type:** Technical Strategy & Architecture Report  
**Subject:** Ship Tracking Timeseries Data — Hot/Cold Storage Tiering  
**Scope:** On-Premise Infrastructure  
**Data Retention:** Hot: 1 Year | Cold: 5 Years  

---

## 1. Introduction

### 1.1 Problem Statement

Ship tracking systems continuously ingest AIS (Automatic Identification System) position reports at high frequency. Over multi-year retention periods, this results in hundreds of billions of records requiring a tiered storage architecture that balances:

- **Performance** — real-time queries on recent data
- **Cost** — economical storage for historical data
- **Queryability** — ability to query cold data without complex restoration processes

### 1.2 Data Profile

| Parameter | Value |
|-----------|-------|
| Vessels tracked | 1,25,000 |
| Ingest rate | 1,000 records/second |
| Records per day (all vessels) | ~86.4 million |
| Records per year (all vessels) | ~31.5 billion |
| Records per vessel per day | ~691 |
| Average report interval per vessel | ~125 seconds |
| Raw document size (uncompressed) | ~2 KB |
| Uncompressed data per year | ~63.1 TB |
| Uncompressed data — 5 years cold | ~315.4 TB |

### 1.3 Scale Context

```
┌────────────────────────────────────────────────────────────────────┐
│                   DATA VOLUME AT SCALE                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Ingest: 1,000 records/sec × 86,400 sec/day = 86.4 million/day     │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1 YEAR (Hot):                                                │   │
│  │   Records: ~31.5 billion                                     │   │
│  │   Uncompressed: ~63.1 TB                                     │   │
│  │   Assumed 10:1 compressed: ~6.3 TB                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 5 YEARS (Cold):                                              │   │
│  │   Records: ~157.5 billion                                    │   │
│  │   Uncompressed: ~315.4 TB                                    │   │
│  │   Assumed 10:1 compressed: ~31.5 TB                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 1.4 Requirements

| Requirement | Hot Tier | Cold Tier |
|-------------|----------|-----------|
| Retention | 12 months | 5 years |
| Access pattern | Real-time, frequent | Analytical, infrequent |
| Query latency | <10ms | Seconds acceptable |
| Storage medium | SSD / NVMe | HDD / Object Storage |
| Query capability | Full CRUD, aggregation | Read-only, analytical |
| Availability | High (3-node replica) | Standard (2-node acceptable) |

---

## 2. Foundational Concepts

### 2.1 Compression Assumption (10:1)

For capacity planning in this report, all compressed-size calculations use a uniform assumed effective compression ratio of 10:1.

```
┌────────────────────────────────────────────────────────────────────┐
│              COMPRESSION ALGORITHM COMPARISON                        │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ASSUMED COMPRESSION FOR SIZING                                     │
│  ─────────────────────────────                                       │
│  • Effective compression ratio: 10:1                                │
│  • Applied uniformly across capacity estimates                       │
│  • Used for hot and cold sizing calculations                         │
│  • Actual ratios vary by schema and workload                         │
│                                                                     │
│  IMPACT (full fleet, 1 year of data):                               │
│                                                                     │
│    Uncompressed:    ~63.1 TB                                        │
│    Assumed compressed: ~6.3 TB (10× reduction)                      │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 Pre-Aggregation Roll-Up Pattern

Instead of retaining every raw data point indefinitely, pre-aggregation summarizes data at coarser time intervals. This is the **single most impactful technique** for reducing cold storage volume.

```
┌────────────────────────────────────────────────────────────────────┐
│           GRANULARITY vs DOCUMENT COUNT REDUCTION                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  RAW (~125-second intervals per vessel)                             │
│  ████████████████████████████████████  691 documents/day/vessel    │
│                                            86.4 million/day total   │
│                                                                     │
│  5-MINUTE Roll-Up                                                   │
│  ██████████                             288 documents/day/vessel   │
│  Reduction: ~2.4×                           36 million/day total   │
│                                                                     │
│  HOURLY Roll-Up                                                     │
│  ██                                      24 documents/day/vessel   │
│  Reduction: ~29×                             3 million/day total   │
│                                                                     │
│  DAILY Roll-Up                                                      │
│  ▎                                        1 document/day/vessel    │
│  Reduction: ~691×                          125,000 docs/day total  │
│                                                                     │
│  VOYAGE Roll-Up                                                     │
│  .                                     ~0.1 document/day/vessel    │
│  Reduction: ~6,900×                     ~12,500 docs/day total     │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Storage impact (1,25,000 vessels, 5 years cold, assumed 10:1 compression):**

| Approach | Document Count (5yr cold) | Storage Size (assumed 10:1) |
|----------|--------------------------|---------------------|
| Raw data | ~157.5 billion | ~31.5 TB |
| 5-minute roll-ups | ~16.4 billion | ~3.3 TB |
| Hourly roll-ups | ~5.5 billion | ~1.1 TB |
| Daily roll-ups | ~228 million | ~45 GB |
| Hourly + Daily combined | ~5.7 billion | ~1.15 TB |

**Critical trade-off:** Roll-ups are lossy. Individual position reports cannot be reconstructed from aggregated summaries. The roll-up granularity must be chosen based on what cold-tier queries need to answer.

### 2.3 Roll-Up Granularity Selection for Cold Data

For cold data, the granularity of roll-ups can be tuned to **minutes or hours** depending on query requirements. Reducing granularity is the most powerful lever to shrink cold storage. Cold data does not need per-second or per-record resolution — by keeping roll-ups at 5-minute, 15-minute, or hourly intervals, the data volume drops dramatically while still supporting meaningful analytical queries.

```
┌────────────────────────────────────────────────────────────────────┐
│     COLD DATA GRANULARITY OPTIONS & IMPACT                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Original raw: ~691 records/day/vessel (at ~125 sec interval)       │
│                                                                     │
│  OPTION 1: 5-Minute Granularity (Cold)                              │
│  ─────────────────────────────────────                              │
│  • 288 documents/day/vessel                                         │
│  • Still captures short-duration events (port approach, turns)      │
│  • Suitable if cold queries need sub-hour precision                 │
│  • Reduction: ~2.4× vs raw                                          │
│                                                                     │
│  OPTION 2: 15-Minute Granularity (Cold)                             │
│  ──────────────────────────────────────                             │
│  • 96 documents/day/vessel                                          │
│  • Good balance: captures route segments, speed changes             │
│  • Sufficient for most voyage reconstruction                        │
│  • Reduction: ~7× vs raw                                            │
│                                                                     │
│  OPTION 3: Hourly Granularity (Cold) ◄── RECOMMENDED                │
│  ─────────────────────────────────────                              │
│  • 24 documents/day/vessel                                          │
│  • Covers trend analysis, speed profiles, distance tracking         │
│  • Answers 95% of historical analytical queries                     │
│  • Reduction: ~29× vs raw                                           │
│                                                                     │
│  OPTION 4: Daily Granularity (Cold)                                 │
│  ──────────────────────────────────                                 │
│  • 1 document/day/vessel                                            │
│  • Only for high-level fleet reporting                              │
│  • Cannot answer intra-day questions                                │
│  • Reduction: ~691× vs raw                                          │
│                                                                     │
│  MULTI-TIER: Combine hourly + daily for different query patterns    │
│  • Hourly for operational analytics                                  │
│  • Daily for fleet dashboards and KPIs                              │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Choosing the right cold granularity:**

| Query Requirement | Minimum Granularity Needed |
|-------------------|---------------------------|
| "Was vessel in port at 3 PM on March 5?" | 15-minute or hourly |
| "Average speed during Q1 2024" | Daily sufficient |
| "Route taken through strait on specific day" | 5-minute or 15-minute |
| "Total distance per month for fleet" | Daily sufficient |
| "Speed profile during specific voyage" | Hourly sufficient |
| "Exact position at 14:32:07" | Not possible with roll-ups (need raw) |



## 3. Strategy A: MongoDB Hot + MongoDB Cold with Pre-Aggregated Roll-Ups

### 3.1 Summary

Two MongoDB clusters — a high-performance hot cluster on SSD for real-time data and a cost-optimized cold cluster on HDD storing only pre-aggregated summaries (hourly, daily, voyage roll-ups). Raw data is discarded after roll-ups are computed and verified.

**Use case:** Historical queries need only summaries and trends, not individual position reports.

### 3.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│          STRATEGY A: MongoDB Hot + MongoDB Cold (ROLL-UPS ONLY)          │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────────┐     │
│    │                     APPLICATION LAYER                          │     │
│    │                                                                │     │
│    │    Real-time queries ──────────► HOT CLUSTER                   │     │
│    │    (last 12 months)                                            │     │
│    │                                                                │     │
│    │    Historical analytics ───────► COLD CLUSTER                  │     │
│    │    (1–5 years, summaries)         (roll-up collections)        │     │
│    │                                                                │     │
│    └───────────────────────┬──────────────────────┬─────────────────┘     │
│                            │                      │                       │
│                            ▼                      ▼                       │
│                                                                          │
│    ┌────────────────────────────┐    ┌────────────────────────────────┐ │
│    │      HOT CLUSTER            │    │       COLD CLUSTER              │ │
│    │      (Sharded Cluster)      │    │       (Replica Set)             │ │
│    │                              │    │                                  │ │
│    │  Hardware:                   │    │  Hardware:                       │ │
│    │  • NVMe / SSD                │    │  • HDD (high density)            │ │
│    │  • 128–256 GB RAM per shard  │    │  • 64 GB RAM                     │ │
│    │  • 3-node replica × N shards │    │  • 2-node replica + arbiter      │ │
│    │  • Sharded for 1K writes/sec │    │                                  │ │
│    │                              │    │  Compression: Zstd               │ │
│    │  Compression: Snappy         │    │                                  │ │
│    │                              │    │  Collections:                    │ │
│    │  Collections:                │    │  ┌──────────────────────────┐   │ │
│    │  ┌────────────────────────┐ │    │  │ positions_hourly          │   │ │
│    │  │ positions_raw           │ │    │  │ (pre-aggregated, zstd)    │   │ │
│    │  │ (timeseries collection) │ │    │  │                            │   │ │
│    │  │                         │ │    │  │ positions_daily            │   │ │
│    │  │ • Full granularity      │ │    │  │ (pre-aggregated, zstd)    │   │ │
│    │  │ • All indexes           │ │    │  │                            │   │ │
│    │  │ • 12-month retention    │ │    │  │ positions_voyage           │   │ │
│    │  │ • 1,000 writes/sec      │ │    │  │ (pre-aggregated, zstd)    │   │ │
│    │  └────────────────────────┘ │    │  └──────────────────────────┘   │ │
│    │                              │    │                                  │ │
│    │  Size: ~6.3 TB (assumed 10:1)│    │  Indexes: vesselId + time only  │ │
│    │                              │    │  5-year retention                │ │
│    └──────────────┬───────────────┘    │                                  │ │
│                   │                    │  Size: ~1.15 TB total            │ │
│                   │                    │                                  │ │
│                   │                    └──────────────────────────────────┘ │
│                   │                                 ▲                      │
│                   │                                 │                      │
│                   ▼                                 │                      │
│    ┌──────────────────────────────────────────────────────────────────┐  │
│    │                    MIGRATION SERVICE                               │  │
│    │                    (scheduled — weekly)                            │  │
│    │                                                                    │  │
│    │  1. IDENTIFY: Query hot cluster for records older than 12 months   │  │
│    │                                                                    │  │
│    │  2. AGGREGATE: Run aggregation pipeline on hot cluster             │  │
│    │     • $match: timestamp older than 12 months                       │  │
│    │     • $group: by vesselId + hour bucket → hourly roll-up           │  │
│    │     • $group: by vesselId + day bucket → daily roll-up             │  │
│    │     (use secondary read preference to avoid primary load)          │  │
│    │                                                                    │  │
│    │  3. WRITE: Insert roll-ups into cold cluster (zstd collections)    │  │
│    │                                                                    │  │
│    │  4. VERIFY: Confirm roll-up counts match expected source records   │  │
│    │                                                                    │  │
│    │  5. PURGE: Delete aged raw data from hot cluster                   │  │
│    │     (ONLY after verification passes)                               │  │
│    │                                                                    │  │
│    └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Query Examples

| Query | Target | Expected Latency |
|-------|--------|-----------------|
| Current position of vessel X | Hot → `positions_raw` | <10ms |
| Vessel X speed trend last 6 months | Hot → `positions_raw` | <100ms |
| Average speed of vessel X over 3 years | Cold → `positions_hourly` | <500ms |
| Total distance by fleet in 2023 | Cold → `positions_daily` | <1s |
| All voyages for vessel X last 4 years | Cold → `positions_voyage` | <100ms |

### 3.4 Pros

- Uniform query interface — same MongoDB driver and query language for both tiers
- Cold queries are fast (entire roll-up dataset fits in RAM)
- Lower cold-tier infrastructure and operations overhead than raw-retention designs
- Application routing logic is simple (time range check)
- Hourly or minute-level granularity on cold keeps queries meaningful while drastically reducing volume

### 3.5 Cons

- **Raw data is discarded** — cannot answer "exact position at 14:32:07 on March 3, 2023"
- Roll-up schema must be designed upfront; adding new metrics retroactively is impossible for already-aggregated data
- Migration service is a custom component that must be reliable
- If roll-up granularity is too coarse, some queries cannot be satisfied

### 3.6 Storage Estimate

| Component | Size | Storage Type |
|-----------|------|-------------|
| Hot cluster (1yr raw, assumed 10:1) | ~6.3 TB | SSD |
| Cold cluster (5yr hourly roll-ups, assumed 10:1) | ~1.1 TB | HDD |
| Cold cluster (5yr daily roll-ups, zstd) | ~45 GB | HDD |
| Cold cluster (5yr voyage roll-ups, assumed 10:1) | ~4.5 GB | HDD |
| **Total** | **~7.45 TB** | |

### 3.7 When to Choose This Strategy

- Historical queries are primarily analytical (trends, averages, summaries)
- No regulatory or contractual requirement to retain raw positions beyond 1 year
- Minimizing cold storage cost and operational burden is the priority
- Team is MongoDB-native and prefers a single query language

---

## 4. Strategy B: MongoDB Hot + MongoDB Cold with Actual (Raw) Data

### 4.1 Summary

Two MongoDB clusters — hot cluster on SSD for real-time data and cold cluster on HDD retaining full raw data with zstd compression. All original position records are preserved and queryable on the cold tier. Pre-aggregated roll-up collections exist alongside raw data to accelerate common analytical queries without scanning billions of documents.

**Use case:** Raw position data must remain queryable for compliance, incident investigation, or contractual obligations.

### 4.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│         STRATEGY B: MongoDB Hot + MongoDB Cold (RAW DATA RETAINED)       │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────────┐     │
│    │                     APPLICATION LAYER                          │     │
│    │                                                                │     │
│    │    Real-time queries ──────────► HOT CLUSTER                   │     │
│    │    (last 12 months)                                            │     │
│    │                                                                │     │
│    │    Historical (analytics) ─────► COLD CLUSTER (roll-ups)       │     │
│    │    Historical (exact data) ────► COLD CLUSTER (raw archive)    │     │
│    │                                                                │     │
│    └───────────────────────┬──────────────────────┬─────────────────┘     │
│                            │                      │                       │
│                            ▼                      ▼                       │
│                                                                          │
│    ┌────────────────────────────┐    ┌────────────────────────────────┐ │
│    │      HOT CLUSTER            │    │       COLD CLUSTER              │ │
│    │      (Sharded Cluster)      │    │       (Sharded Cluster)         │ │
│    │                              │    │                                  │ │
│    │  Hardware:                   │    │  Hardware:                       │ │
│    │  • NVMe / SSD                │    │  • HDD (high density, RAID)      │ │
│    │  • 128–256 GB RAM per shard  │    │  • 128 GB RAM per shard          │ │
│    │  • 3-node replica × N shards │    │  • 3-node replica × M shards    │ │
│    │  • Sharded for 1K writes/sec │    │    (or 2-node + arbiter)         │ │
│    │                              │    │                                  │ │
│    │  Compression: Snappy         │    │  Compression: Zstd               │ │
│    │                              │    │                                  │ │
│    │  Collections:                │    │  Collections:                    │ │
│    │  ┌────────────────────────┐ │    │  ┌──────────────────────────┐   │ │
│    │  │ positions_raw           │ │    │  │ positions_raw_archive     │   │ │
│    │  │ (timeseries collection) │ │    │  │ (timeseries, zstd)        │   │ │
│    │  │                         │ │    │  │                            │   │ │
│    │  │ • Full granularity      │ │    │  │ • FULL raw data retained   │   │ │
│    │  │ • All indexes           │ │    │  │ • 5-year retention         │   │ │
│    │  │ • 12-month retention    │ │    │  │ • ~157.5 billion documents │   │ │
│    │  │ • 1,000 writes/sec      │ │    │  │ • Sharded by vesselId +   │   │ │
│    │  └────────────────────────┘ │    │  │   timestamp                │   │ │
│    │                              │    │  │ • Sparse indexes           │   │ │
│    │  Size: ~6.3 TB               │    │  │                            │   │ │
│    │                              │    │  │ Size: ~31.5 TB             │   │ │
│    └──────────────┬───────────────┘    │  └──────────────────────────┘   │ │
│                   │                    │                                  │ │
│                   │                    │  ┌──────────────────────────┐   │ │
│                   │                    │  │ positions_hourly          │   │ │
│                   │                    │  │ (roll-ups, zstd)          │   │ │
│                   │                    │  │                            │   │ │
│                   │                    │  │ positions_daily            │   │ │
│                   │                    │  │ (roll-ups, zstd)          │   │ │
│                   │                    │  │                            │   │ │
│                   │                    │  │ Size: ~1.15 TB            │   │ │
│                   │                    │  └──────────────────────────┘   │ │
│                   │                    │                                  │ │
│                   │                    └──────────────────────────────────┘ │
│                   │                                 ▲                      │
│                   │                                 │                      │
│                   ▼                                 │                      │
│    ┌──────────────────────────────────────────────────────────────────┐  │
│    │                    MIGRATION SERVICE                               │  │
│    │                    (scheduled — weekly)                            │  │
│    │                                                                    │  │
│    │  1. IDENTIFY: Records in hot cluster older than 12 months          │  │
│    │                                                                    │  │
│    │  2. COPY RAW: Bulk copy raw documents from hot to cold cluster     │  │
│    │     • Use aggregation $merge or bulk read/write pipeline           │  │
│    │     • Write to positions_raw_archive (zstd collection)             │  │
│    │     • Capacity estimates assume effective 10:1 compression         │  │
│    │                                                                    │  │
│    │  3. AGGREGATE: Compute hourly/daily roll-ups from migrated data    │  │
│    │     • Write to positions_hourly, positions_daily                   │  │
│    │     • Accelerates common analytical queries on cold tier            │  │
│    │                                                                    │  │
│    │  4. VERIFY: Document count + sample checksums match                │  │
│    │                                                                    │  │
│    │  5. PURGE: Delete aged raw data from hot cluster                   │  │
│    │     (ONLY after full verification)                                 │  │
│    │                                                                    │  │
│    │  Migration throughput: ~600M records/week batch                     │  │
│    │  (~86.4M/day × 7 days worth of aged data)                          │  │
│    │                                                                    │  │
│    └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Query Examples

| Query | Target | Expected Latency |
|-------|--------|-----------------|
| Current position of vessel X | Hot → `positions_raw` | <10ms |
| Exact position at specific timestamp (old) | Cold → `positions_raw_archive` | 1–10s |
| Average speed over 3 years | Cold → `positions_hourly` | <1s |
| All positions in area on historical date | Cold → `positions_raw_archive` | 10–60s |
| Route reconstruction for incident | Cold → `positions_raw_archive` | 5–30s |
| Fleet distance summary 2023 | Cold → `positions_daily` | <1s |

### 4.4 Pros

- **Full data preservation** — every raw position report queryable for 5 years
- Same MongoDB query language across hot and cold
- Can answer any historical query at full granularity (no information loss)
- Roll-ups accelerate common analytical queries (avoid scanning billions of docs)
- Strong fit for compliance and investigation workflows requiring exact historical replay

### 4.5 Cons

- **Very large cold storage footprint** (~31.5 TB for 5 years)
- Cold cluster needs significant RAM for indexes over ~157.5 billion documents
- Queries on cold raw data are slower (HDD + massive dataset)
- Migration moves ~600M records/week (network and compute intensive)
- Index maintenance on billions of documents is operationally challenging

### 4.6 Storage Estimate

| Component | Size | Storage Type |
|-----------|------|-------------|
| Hot cluster (1yr raw, assumed 10:1) | ~6.3 TB | SSD |
| Cold cluster (5yr raw, assumed 10:1) | ~31.5 TB | HDD |
| Cold cluster (5yr hourly roll-ups, assumed 10:1) | ~1.1 TB | HDD |
| Cold cluster (5yr daily roll-ups, zstd) | ~45 GB | HDD |
| **Total** | **~39.0 TB** | |

### 4.7 When to Choose This Strategy

- Regulatory or contractual obligation to retain all raw position data for 5+ years
- Requirement for incident investigation at full granularity on historical data
- Need to reconstruct exact vessel routes/positions from any point in history
- Organization is willing to invest in significant cold-tier infrastructure
- Geofence alerting or historical area-based queries required on old data

---

## 5. Strategy C: MongoDB Hot + MinIO Cold (Object Storage)

### 5.1 Summary

MongoDB hot cluster for real-time operations. MinIO (S3-compatible object storage) on commodity HDD hardware for long-term cold storage. Raw data exported as Parquet files (columnar format) to MinIO. Pre-aggregated roll-ups stored in a small MongoDB instance for fast analytical queries. Cold raw data queryable via SQL engines (Trino, DuckDB, or Apache Spark). For exception workflows, cold slices can be restored on demand from MinIO into temporary MongoDB collections to run MongoDB-native queries.

**Use case:** Cost-sensitive environments needing raw data retention at minimal expense, with most cold queries served by roll-ups and only occasional raw data access.

### 5.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│              STRATEGY C: MongoDB Hot + MinIO Cold                         │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────────┐     │
│    │                     APPLICATION LAYER                          │     │
│    │                                                                │     │
│    │    Real-time queries ──────────────► MongoDB Hot Cluster        │     │
│    │    (last 12 months)                                            │     │
│    │                                                                │     │
│    │    Historical analytics ───────────► MongoDB Roll-Up Store      │     │
│    │    (summaries, trends — 95% of       (small, fast)             │     │
│    │     cold queries)                                              │     │
│    │                                                                │     │
│    │    Historical raw data deep-dive ──► Trino / DuckDB            │     │
│    │    (exact positions, compliance       (SQL over MinIO Parquet)  │     │
│    │     — 5% of cold queries)                                      │     │
│    │                                                                │     │
│    └──────────┬──────────────────┬────────────────────┬─────────────┘     │
│               │                  │                    │                   │
│               ▼                  ▼                    ▼                   │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐│
│  │  MONGODB          │  │  MONGODB          │  │  QUERY ENGINE           ││
│  │  HOT CLUSTER      │  │  ROLL-UP STORE    │  │  (Trino / DuckDB)       ││
│  │  (Sharded)        │  │                    │  │                          ││
│  │                    │  │  Hardware:         │  │  • SQL interface          ││
│  │  Hardware:         │  │  • HDD (or SSD)   │  │  • Reads Parquet from    ││
│  │  • NVMe / SSD      │  │  • 32–64 GB RAM   │  │    MinIO via S3 API      ││
│  │  • 128–256 GB RAM  │  │  • 2-node replica │  │  • Partition pruning     ││
│  │  • 3-node × N      │  │                    │  │    by year/month/vessel  ││
│  │    shards          │  │  Compression:      │  │                          ││
│  │                    │  │  Zstd              │  └────────────┬─────────────┘│
│  │  Compression:      │  │                    │               │             │
│  │  Snappy            │  │  Collections:      │               │             │
│  │                    │  │  ┌──────────────┐ │               │             │
│  │  Collections:      │  │  │hourly_rollups│ │               │             │
│  │  ┌──────────────┐ │  │  │daily_rollups │ │               │             │
│  │  │positions_raw  │ │  │  │voyage_rollups│ │               │             │
│  │  │(timeseries)   │ │  │  │              │ │               │             │
│  │  │               │ │  │  │5-year retain │ │               │             │
│  │  │12-month       │ │  │  │~1.15 TB total│ │               │             │
│  │  │retention      │ │  │  └──────────────┘ │               │             │
│  │  └──────────────┘ │  │                    │               │             │
│  │                    │  └────────────────────┘               │             │
│  │  Size: ~6.3 TB     │                                       │             │
│  │                    │                                       │             │
│  └────────┬───────────┘                                       │             │
│           │                                                   │             │
│           ▼                                                   ▼             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    ETL / MIGRATION SERVICE                            │  │
│  │                    (scheduled — weekly)                               │  │
│  │                                                                       │  │
│  │  1. IDENTIFY: Records in hot cluster older than 12 months             │  │
│  │                                                                       │  │
│  │  2. AGGREGATE: Compute hourly/daily/voyage roll-ups                   │  │
│  │     • Write to MongoDB Roll-Up Store (zstd)                           │  │
│  │                                                                       │  │
│  │  3. EXPORT: Convert raw documents to Apache Parquet format            │  │
│  │     • Capacity assumptions use 10:1 compression for sizing            │  │
│  │     • Partition by year / month / vesselId                            │  │
│  │     • Upload to MinIO via S3 PUT API                                  │  │
│  │     • Batch: ~600M records/week                                       │  │
│  │                                                                       │  │
│  │  4. VERIFY: Record counts + checksums confirmed                       │  │
│  │                                                                       │  │
│  │  5. PURGE: Delete aged data from hot cluster                          │  │
│  │                                                                       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│                                         │                                │
│                                         ▼                                │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                       MinIO CLUSTER                                   ││
│  │                       (S3-compatible Object Storage)                   ││
│  │                                                                       ││
│  │  Hardware:                                                            ││
│  │  • Commodity HDD (high density, 4+ nodes)                             ││
│  │  • Erasure coding (data protection without full replication)          ││
│  │  • Minimal RAM required (not a database — just storage)              ││
│  │                                                                       ││
│  │  Storage Layout:                                                      ││
│  │  s3://ship-archive/                                                   ││
│  │    └── positions/                                                     ││
│  │        ├── year=2025/                                                 ││
│  │        │   ├── month=01/                                              ││
│  │        │   │   ├── vessel=IMO9434567/positions.parquet                ││
│  │        │   │   ├── vessel=IMO9876543/positions.parquet                ││
│  │        │   │   └── ... (1,25,000 vessel files per month)              ││
│  │        │   ├── month=02/                                              ││
│  │        │   └── ...                                                    ││
│  │        ├── year=2024/                                                 ││
│  │        └── ...                                                        ││
│  │                                                                       ││
│  │  Properties:                                                          ││
│  │  • Capacity calculations in this report use assumed 10:1 compression  ││
│  │  • Immutable files — append only, never modified                     ││
│  │  • Erasure coding = data protection with ~1.5× overhead (vs 3×)      ││
│  │  • Scales linearly — add disks/nodes for capacity                    ││
│  │  • No license cost (open source)                                      ││
│  │                                                                       ││
│  │  Size: ~31.5 TB (5 years, 1,25,000 vessels, assumed 10:1)            ││
│  │                                                                       ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Query Routing Logic

```
┌────────────────────────────────────────────────────────────────┐
│                      QUERY ROUTING                               │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  INCOMING QUERY                                                  │
│       │                                                          │
│       ▼                                                          │
│  Is time range within last 12 months?                            │
│       │                                                          │
│       ├── YES ──► MongoDB Hot Cluster (positions_raw)            │
│       │           Latency: <10ms                                 │
│       │                                                          │
│       └── NO (historical)                                        │
│            │                                                     │
│            ▼                                                     │
│       Is query analytical? (averages, trends, summaries)         │
│            │                                                     │
│            ├── YES ──► MongoDB Roll-Up Store                     │
│            │           (hourly/daily/voyage collections)          │
│            │           Latency: <1s                               │
│            │           Serves: 95% of cold queries               │
│            │                                                     │
│            └── NO (needs exact raw positions)                    │
│                 │                                                │
│                 ├──► Trino/DuckDB over MinIO Parquet             │
│                 │    Latency: 10–120 seconds                     │
│                 │    Serves: 5% of cold queries                  │
│                 │    (incident investigation, compliance audit)  │
│                 │                                                │
│                 └──► Restore-on-demand to temporary MongoDB      │
│                      collection (for Mongo-native/geo queries)   │
│                      Latency: minutes (batch dependent)          │
│                      Data expires by TTL after query completion  │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

### 5.4 Pros

- **Lowest cold storage cost** — MinIO on commodity HDD with erasure coding
- Uses object storage economics for cold archive while report sizing assumes 10:1 compression
- Roll-ups in MongoDB serve 95% of cold queries at native speed
- Raw data fully preserved for compliance — no data loss
- Clear separation: "queryable cold" (MongoDB roll-ups) vs "archival cold" (MinIO)
- Storage overhead for protection is only ~1.5× (erasure coding vs 3× replication)
- Supports restore-on-demand for exceptional MongoDB-native cold queries without keeping all raw cold data in MongoDB

### 5.5 Cons

- **Three systems to manage** (MongoDB, MinIO, query engine)
- Raw data queries require SQL (Trino/DuckDB) — different language than MongoDB
- Higher operational complexity (ETL has two outputs: roll-ups + Parquet)
- Team needs both MongoDB and data engineering/SQL skills
- Raw queries on MinIO are slow (10s–2min for large scans) — not suitable for real-time
- Large Parquet export volume (~600M records/week)
- Restore-on-demand adds orchestration overhead (temp collection lifecycle, index creation, cleanup, and access controls)

### 5.6 When to Choose This Strategy

- Cold storage cost is the primary driver
- Raw data must be retained for compliance but is rarely accessed (<5% of queries)
- Organization is comfortable managing object storage infrastructure (MinIO)
- Team has SQL/data engineering skills for Trino/DuckDB
- Data volumes are expected to grow significantly
- Audit trail or regulatory retention mandates exist
- Occasional historical cases need MongoDB-specific query features (for example geospatial filters) via temporary rehydration

---

## 6. Cumulative Storage Reduction — All Levers Combined

```
┌────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Starting: 5 years, 1,25,000 vessels, 1000 rec/sec, raw = ~315.4 TB    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │ Lever 1: Apply assumed 10:1 compression                        │     │
│  │ 315.4 TB → 31.5 TB                              10× saved    │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                          │                                              │
│                          ▼                                              │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │ Lever 2: Hourly pre-aggregation roll-ups (cold only)           │     │
│  │ 31.5 TB → ~1.1 TB                               ~29× saved   │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                          │                                              │
│                          ▼                                              │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │ Lever 3: Daily pre-aggregation (for reporting workloads)       │     │
│  │ 31.5 TB → ~45 GB                                ~700× saved  │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                          │                                              │
│                          ▼                                              │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │ Lever 4: MinIO erasure coding overhead (physical disk)         │     │
│  │ 31.5 TB usable → ~47.3 TB raw disk              ~1.5× overhead│     │
│  └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  FINAL STATES:                                                          │
│  ─────────────                                                          │
│  Strategy A: ~1.15 TB cold  (roll-ups only, raw discarded)              │
│  Strategy B: ~31.5 TB cold  (raw in MongoDB + roll-ups)                 │
│  Strategy C: ~31.5 TB cold  (raw in MinIO + roll-ups in Mongo)          │
│                                                                         │
│  vs storing everything raw uncompressed: ~315.4 TB cold                 │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Lifecycle Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                       DATA LIFECYCLE FLOW                            │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  INGEST (1,000 records/second, 1,25,000 vessels)                    │
│    │                                                                │
│    ▼                                                                │
│  HOT TIER (MongoDB, SSD, assumed 10:1, 0–12 months)                │
│    │  • Full granularity                                            │
│    │  • Full indexing, sharded for write throughput                  │
│    │  • Real-time queries                                           │
│    │  • ~6.3 TB storage                                             │
│    │                                                                │
│    │──── [Weekly migration job at 12-month boundary] ────           │
│    │                                                                │
│    ▼                                                                │
│  COMPUTE ROLL-UPS (reduce granularity to minutes/hours for cold)    │
│    │  • Aggregation pipeline: hourly, daily, voyage summaries       │
│    │  • Hourly granularity = 29× fewer documents                    │
│    │  • Capacity planning uses assumed 10:1 compression             │
│    │  • ~600M records/week processed                                │
│    │                                                                │
│    ├──── Strategy A: Discard raw, keep roll-ups only                │
│    │                                                                │
│    ├──── Strategy B: Copy raw to cold MongoDB (zstd) + roll-ups    │
│    │                                                                │
│    └──── Strategy C: Export raw to MinIO (Parquet) + roll-ups      │
│                                                                     │
│  COLD TIER (1–5 years)                                              │
│    │  • Roll-ups serve analytical queries (<1s)                     │
│    │  • Raw data (if retained) for compliance/deep-dive            │
│    │  • Reduced granularity = reduced storage + faster queries      │
│    │                                                                │
│    │──── [5-year retention limit] ────                              │
│    │                                                                │
│    ▼                                                                │
│  PURGE                                                              │
│    • Data older than 5 years deleted                                │
│    • TTL index or scheduled cleanup                                 │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 8. Migration Workflow Detail

```
┌────────────────────────────────────────────────────────────────────┐
│                  WEEKLY MIGRATION WORKFLOW                           │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────┐    ┌─────────────┐    ┌─────────────┐    ┌────────────┐ │
│  │START│───►│ IDENTIFY    │───►│ AGGREGATE   │───►│ WRITE      │ │
│  └─────┘    │ aged data   │    │ roll-ups    │    │ to cold    │ │
│             │ (>12 months)│    │ (hourly,    │    │ tier       │ │
│             │             │    │  daily,     │    │ (zstd)     │ │
│             │ ~600M recs  │    │  voyage)    │    │            │ │
│             └─────────────┘    └─────────────┘    └──────┬─────┘ │
│                                                          │       │
│                                                          ▼       │
│  ┌─────┐    ┌─────────────┐    ┌─────────────┐    ┌────────────┐ │
│  │DONE │◄───│ PURGE       │◄───│ VERIFY      │◄───│ EXPORT RAW │ │
│  └─────┘    │ from hot    │    │ checksums   │    │ (Strategy  │ │
│             │ (only after │    │ & counts    │    │  B: MongoDB│ │
│             │  verify)    │    │             │    │  C: MinIO) │ │
│             └─────────────┘    └─────────────┘    └────────────┘ │
│                                                                     │
│  Safety rules:                                                      │
│  • NEVER purge before verification passes                          │
│  • Idempotent: re-running produces same result (upsert semantics)  │
│  • Observable: metrics on lag, success rate, processing time        │
│  • Use secondary read preference to avoid hot cluster primary load  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## 9. Recommendation

### 9.1 Pre-Aggregation is the Foundation

**The pre-aggregation roll-up pattern should be implemented regardless of which infrastructure strategy is selected.** It is the single most impactful technique:

- ~29× document count reduction at hourly granularity (or ~7× at 15-minute)
- Sub-second analytical queries on cold data (vs minutes scanning raw)
- Dramatically reduced cold-tier hardware requirements
- Simpler backups, faster restores, lower operational overhead
- Works equally well with any cold storage backend
- Keeping cold data at minute or hour granularity still answers 95% of historical queries

### 9.2 Strategy Selection Guide

```
┌────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Do you need raw position data queryable after 12 months?       │
│       │                                                         │
│       ├── NO                                                    │
│       │   └── ✅ STRATEGY A: MongoDB Hot + Cold (Roll-Ups Only) │
│       │       • Lowest cost, simplest operations                │
│       │       • Cold tier: ~1.15 TB                             │
│       │       • Best if no compliance/retention mandate          │
│       │                                                         │
│       └── YES                                                   │
│            │                                                    │
│            ▼                                                    │
│       Is cold storage cost the primary constraint?              │
│            │                                                    │
│            ├── NO (performance & query simplicity matter more)   │
│            │   └── ✅ STRATEGY B: MongoDB Hot + Cold (Raw)       │
│            │       • Full raw data queryable via MongoDB         │
│            │       • Same query language everywhere              │
│            │       • Cold tier: ~31.5 TB                         │
│            │       • Higher hardware investment                  │
│            │                                                    │
│            └── YES (minimize cost, raw access is rare)           │
│                └── ✅ STRATEGY C: MongoDB Hot + MinIO Cold        │
│                    • Cheapest raw archival (Parquet + MinIO)     │
│                    • Roll-ups in MongoDB for 95% of queries     │
│                    • Cold tier: ~31.5 TB                         │
│                    • Accept SQL for raw queries + more ops       │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 9.3 Universal Recommendations (All Strategies)

1. **Use a documented sizing assumption** (10:1 in this report) and validate with PoC on production-like data
2. **Implement hourly + daily roll-ups** — covers 95% of historical query needs
3. **Reduce cold granularity to minutes or hours** — the most powerful storage reduction lever
4. **Design roll-up schema upfront** — changing it retroactively is expensive for already-processed data
5. **Never purge hot data before cold write is verified** — checksums + counts must match
6. **Monitor migration pipeline** — lag, success rate, processing time, storage growth
7. **Use secondary read preference** during migration to protect hot cluster primary performance

---

> **Note:** All storage sizes, document counts, and compression ratios presented in this report are illustrative estimates based on the stated data profile (1,25,000 vessels, 1,000 records/sec, ~2 KB/document) and an assumed effective compression ratio of 10:1. Actual sizes will vary depending on document structure, field count, index design, data distribution patterns, and compression effectiveness on real workloads. These calculations are provided as reference examples to compare the relative impact of each strategy. Actual sizing should be validated through proof-of-concept testing with representative production data.

---

*End of Report*
