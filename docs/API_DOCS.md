# API Documentation

## Base URL

```
http://localhost:3000
```

## Authentication

Pass the user ID via the `x-user-id` header for user-specific flags (TOI, Remarks).

---

## Endpoints

### GET /health

Health check endpoint.

**Response:**
```json
{ "status": "ok", "documents": 125000, "timestamp": "2026-02-04T16:01:19Z" }
```

---

### GET /tracks

Get ship tracks with color logic and user-specific flags.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 100 | Max results (up to 10,000) |
| skip | number | 0 | Offset for pagination |
| nationality | number | - | Filter by nationality code |
| ship_type | string | - | Filter by ship type |
| risk_level | string | - | Filter by risk level |
| sort | string | reported_time_info | Sort field |
| order | string | desc | Sort order (asc/desc) |

**Headers:**
- `x-user-id` - User ID for TOI/Remark flags

**Example:**
```bash
curl "http://localhost:3000/tracks?limit=100&nationality=419" \
  -H "x-user-id: user-123"
```

---

### GET /tracks/overlay

Find ships within a GeoJSON polygon.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| polygon | JSON | Yes | GeoJSON Polygon |
| limit | number | No | Max results (default: 1000) |

**Example:**
```bash
curl "http://localhost:3000/tracks/overlay?polygon=%7B%22type%22%3A%22Polygon%22%2C%22coordinates%22%3A%5B%5B%5B50%2C-30%5D%2C%5B50%2C10%5D%2C%5B90%2C10%5D%2C%5B90%2C-30%5D%2C%5B50%2C-30%5D%5D%5D%7D" \
  -H "x-user-id: user-123"
```

---

### GET /tracks/stats

Aggregated statistics across all ships.

**Example:**
```bash
curl "http://localhost:3000/tracks/stats"
```

---

### GET /tracks/:suid

Get a single ship by SUID.

---

### POST /tracks/:suid/toi

Toggle Track of Interest for the current user.

**Headers:** `x-user-id` (required)

---

### POST /tracks/:suid/remark

Toggle remark flag for the current user.

**Headers:** `x-user-id` (required)

---

### GET /wfs

WFS 2.0-compatible endpoint backed by MongoDB time-series collection `tracks_local_timeseries`.

**Supported operations:**
- `GetCapabilities`
- `DescribeFeatureType`
- `GetFeature`

**Common query parameters for GetFeature:**

| Param | Type | Description |
|-------|------|-------------|
| service | string | Must be `WFS` |
| request | string | `GetFeature` |
| typeNames | string | `ship_tracking:tracks_local_timeseries` |
| bbox | string | `minx,miny,maxx,maxy` (CRS84 lon/lat) |
| datetime | string | ISO instant or interval (`from/to`) |
| suid | string | Filter by ship identifier |
| nationality | number | Filter by nationality code |
| count | number | Max features to return |
| startIndex | number | Pagination offset |
| view | string | `history` (default) or `latest` (one feature per `suid`) |
| cql_filter | string | Basic CQL with `AND` and operators `= != > >= < <=` |
| outputFormat | string | `application/json` for GeoJSON-like output, XML by default |

**Examples:**
```bash
# Capabilities
curl "http://localhost:3000/wfs?service=WFS&request=GetCapabilities"

# Feature schema
curl "http://localhost:3000/wfs?service=WFS&request=DescribeFeatureType&typeNames=ship_tracking:tracks_local_timeseries"

# Latest features in JSON
curl "http://localhost:3000/wfs?service=WFS&request=GetFeature&typeNames=ship_tracking:tracks_local_timeseries&count=100&outputFormat=application/json"

# Latest per ship (one feature per suid)
curl "http://localhost:3000/wfs?service=WFS&request=GetFeature&typeNames=ship_tracking:tracks_local_timeseries&view=latest&count=200&outputFormat=application/json"

# Spatial + temporal filter
curl "http://localhost:3000/wfs?service=WFS&request=GetFeature&typeNames=ship_tracking:tracks_local_timeseries&bbox=50,-30,90,10&datetime=2026-01-01T00:00:00Z/..&count=500"

# CQL filter (AND-only basic parser)
curl "http://localhost:3000/wfs?service=WFS&request=GetFeature&typeNames=ship_tracking:tracks_local_timeseries&cql_filter=nationality%3D273%20AND%20speed%3E10&outputFormat=application/json"
```
