# 🚢 Ship Tracking System POC

High-performance Proof of Concept for migrating a maritime vessel tracking system from Oracle to MongoDB Atlas. Handles **4,000 updates per second** with **125,000 active ship documents**.

## 📼 Features

✅ **Data Migration**: Oracle relational → MongoDB document model
✅ **High-Frequency Ingestion**: 4,000 ops/sec using bulkWrite
✅ **Geospatial Queries**: GeoJSON ship overlay tracking
✅ **REST API**: Express.js with aggregation pipelines
✅ **Color Logic**: Dynamic nationality-based coloring
✅ **User Flags**: Track of Interest & Remarks per user

## 🏗️ Architecture

### Schema (Flag Approach)

```javascript
{
  suid: "uuid",                                   // Primary key
  mmsi_number: "273393030",                       // Ship identifier
  ship_name: "VESSEL-001",
  nationality: 273,                               // Country code
  latitude: "52.625685",
  longitude: "156.263493",
  trackLocation: {                                // GeoJSON for spatial queries
    type: "Point",
    coordinates: [156.263493, 52.625685]
  },
  course: "359.997",
  speed: "12.50",
  reported_time_info: "2026-02-04T16:01:19Z",

  // Denormalized arrays (eliminates JOINs)
  TOIUserIds: ["user-1", "user-2"],              // Who marked as Track of Interest
  CtrackRemarksUserIDs: ["user-3"],              // Who added remarks

  // ... 30+ additional tracking fields
}
```

### Indexes

| Index | Purpose |
|-------|---------|
| `suid` (unique) | Primary key lookup |
| `trackLocation` (2dsphere) | Geospatial queries |
| `nationality + TOIUserIds` | Filter + flag check |
| `reported_time_info` (desc) | Time-series sorting |

## 🚀 Quick Start

### 1. Prerequisites

```bash
# Node.js 16+
node --version

# MongoDB Atlas cluster (M40 minimum)
# Get connection string from Atlas console
```

### 2. Setup

```bash
# Clone / open in VS Code
code .

# Install dependencies
npm install

# Configure MongoDB
cp .env.example .env
# Edit .env with your MongoDB Atlas URI
```

### 3. Full Setup (5 minutes)

```bash
npm run setup
# Creates indexes + seeds 125,000 documents
```

### 4. Run Everything

```bash
# Start all services in parallel
npm run start

# OR separately:
npm run start-api              # Terminal 1
npm run simulate-ingestion     # Terminal 2
npm run monitor               # Terminal 3
```

## 📡 API Endpoints

### `GET /tracks`

Get all ship tracks with color logic and user-specific flags.

```bash
curl "http://localhost:3000/tracks?limit=100&nationality=419" \
  -H "x-user-id: user-123"
```

**Response:**
```json
{
  "success": true,
  "count": 10,
  "data": [
    {
      "suid": "d516f09a-7a79-4aac-a012-21cd23fe6377",
      "mmsi_number": "273393030",
      "ship_name": "VESSEL-001",
      "nationality": 419,
      "latitude": "52.625685",
      "longitude": "156.263493",
      "course": "359.997",
      "speed": "12.50",
      "color": "#e4e901",        // Yellow for nationality 419
      "IS_TOI": 1,               // User marked as interest
      "IS_REMARK": 0,            // User has remarks
      "reported_time_info": "2026-02-04T16:01:19Z"
    }
  ]
}
```

### `GET /tracks/overlay`

Find ships within a GeoJSON polygon.

```bash
POLYGON='{"type":"Polygon","coordinates":[[[50,-30],[50,10],[90,10],[90,-30],[50,-30]]]}'

curl "http://localhost:3000/tracks/overlay" \
  --data-urlencode "polygon=$POLYGON" \
  -H "x-user-id: user-123"
```

### `GET /tracks/stats`

Aggregate statistics.

```bash
curl "http://localhost:3000/tracks/stats"
```

## 📂 Project Structure

```
ship-tracking-poc/
├── src/
│   ├── indexing/        → Create MongoDB indexes
│   ├── seeding/         → Generate 125k documents
│   ├── api/             → Express REST API
│   ├── simulator/       → 4k ops/sec ingestion
│   ├── monitoring/      → Performance benchmarking
│   └── utils/           → Database & logging utilities
├── docs/                → API & schema documentation
├── tests/               → Integration & load tests
├── scripts/             → Helper shell scripts
└── docker/              → Docker configuration
```

## ⚡ Performance

| Metric | Value |
|--------|-------|
| Target Throughput | 4,000 ops/sec |
| Batch Size | 200 operations |
| Concurrent Batches | 2-4 |
| P99 Latency | 10-20ms |
| MongoDB Tier | M40+ (4GB RAM) |
| Connection Pool | maxPoolSize: 150 |

**Comparison to Oracle:**
- Individual updateOne: 500-1,000 ops/sec
- MongoDB bulkWrite: 4,000-8,000 ops/sec
- **Improvement: 4-8x faster**

## 🔑 Key Optimizations

### 1️⃣ bulkWrite for High-Frequency Updates

```javascript
// Fast: 20 round-trips instead of 4,000
const operations = [];
for (let i = 0; i < 200; i++) {
  operations.push({
    updateOne: {
      filter: { suid },
      update: { $set: { latitude, longitude, ... } },
      upsert: true
    }
  });
}
await collection.bulkWrite(operations, { ordered: false });
```

### 2️⃣ Schema Denormalization (No JOINs)

```javascript
// Single document fetch = all related data
{
  suid: "...",
  TOIUserIds: ["user-1", "user-2"],        // No separate table
  CtrackRemarksUserIDs: ["user-3"],        // No separate table
  // ... all fields in one place
}
```

### 3️⃣ Geospatial with 2dsphere Index

```javascript
// Fast polygon queries with proper indexing
db.ctrack_data.createIndex({ trackLocation: "2dsphere" })

db.ctrack_data.aggregate([
  { $match: { trackLocation: { $geoWithin: { $geometry: polygon } } } }
])
```

### 4️⃣ Aggregation Pipeline at Database Level

```javascript
// Color logic & flags computed at DB, not in application
db.ctrack_data.aggregate([
  {
    $addFields: {
      color: { $cond: [{ $eq: ['$nationality', 419] }, '#e4e901', '#00FF00'] },
      IS_TOI: { $cond: [{ $in: [userId, '$TOIUserIds'] }, 1, 0] }
    }
  }
])
```

### 5️⃣ Window Functions with `$setWindowFields`

MongoDB's `$setWindowFields` stage enables analytics computations (ranking, running totals, moving averages) without pulling data to the application layer — similar to SQL `OVER(PARTITION BY ... ORDER BY ...)`.

```javascript
// Rank ships by speed within each nationality group
db.ctrack_data.aggregate([
  {
    $setWindowFields: {
      partitionBy: "$nationality",
      sortBy: { speed: -1 },
      output: {
        speedRankInNationality: {
          $rank: {}
        }
      }
    }
  }
])

// Moving average of speed over the last 5 reports per ship
db.ctrack_data.aggregate([
  {
    $setWindowFields: {
      partitionBy: "$mmsi_number",
      sortBy: { reported_time_info: 1 },
      output: {
        avgSpeedLast5: {
          $avg: "$speed",
          window: { documents: [-4, 0] }
        }
      }
    }
  }
])

// Time-based window: count position reports per ship in 1-hour intervals
db.ctrack_data.aggregate([
  {
    $setWindowFields: {
      partitionBy: "$mmsi_number",
      sortBy: { reported_time_info: 1 },
      output: {
        reportsInLastHour: {
          $count: {},
          window: { range: [-1, 0], unit: "hour" }
        }
      }
    }
  }
])
```

### 6️⃣ Position Deduplication with `$derivative` Speed Filtering

Uses `$setWindowFields` + `$derivative` to compute the per-second rate of position change, then drops points where the ship is stationary — removing anchored/idle segments while preserving all actual movement.

**API Usage:**
```bash
# Fetch trail with speed-based deduplication (min 8 knots)
curl "http://localhost:3000/tracks/{suid}/history?trail=1&dedupe=1&min_speed=8"
```

**Pipeline Logic:**
```javascript
db.tracks_local_timeseries.aggregate([
  { $match: { suid: "SHIP_SUID" } },
  { $sort: { reported_time_info: -1 } },
  { $limit: 5000 },
  // Re-sort ascending for forward-in-time derivatives
  { $sort: { reported_time_info: 1 } },
  // Step 1 — compute per-second rate of change for lat and lng
  {
    $setWindowFields: {
      partitionBy: "$suid",
      sortBy: { reported_time_info: 1 },
      output: {
        _dLat: { $derivative: { input: "$latitude", unit: "second" }, window: { documents: [-1, 0] } },
        _dLng: { $derivative: { input: "$longitude", unit: "second" }, window: { documents: [-1, 0] } }
      }
    }
  },
  // Step 2 — keep only moving points (|dLat|+|dLng| > threshold)
  {
    $match: {
      $or: [
        { _dLat: null },  // first document (no predecessor)
        { $expr: { $gt: [
          { $add: [{ $abs: "$_dLat" }, { $abs: "$_dLng" }] },
          0.0000370  // threshold = (8kn × 0.514 m/s) / 111000 m/deg
        ]}}
      ]
    }
  },
  // Re-sort descending for frontend rendering
  { $sort: { reported_time_info: -1 } },
  { $project: { _id: 0, latitude: 1, longitude: 1, speed: 1, course: 1, reported_time_info: 1 } }
])
```

**How it works:**
- Converts knot threshold → degrees/second: `(kn × 0.514) / 111000`
- `$derivative` computes rate of lat/lng change between consecutive records
- Points where `|dLat| + |dLng|` falls below threshold are dropped (ship is stationary)
- First point is always kept (null derivative — no predecessor)
- Physically meaningful: filters by actual motion, not grid proximity

**Threshold presets:**
| Knots | Effect |
|-------|--------|
| 0.5 | Drop only anchored/stopped |
| 1 | Drop slow drift & idle |
| 3 | Keep maneuvering + steaming |
| 5 | Keep steaming only |
| 8 | Keep full steaming (recommended for demo) |
| 10+ | Keep high-speed segments only |

### 7️⃣ Speed Anomaly Detection

Detect ships whose current speed deviates more than 2x from their rolling average:

```javascript
db.ctrack_data.aggregate([
  {
    $setWindowFields: {
      partitionBy: "$mmsi_number",
      sortBy: { reported_time_info: 1 },
      output: {
        rollingAvgSpeed: {
          $avg: "$speed",
          window: { documents: [-9, 0] }  // 10-report window
        }
      }
    }
  },
  {
    $addFields: {
      speedAnomaly: {
        $cond: [{ $gt: ["$speed", { $multiply: ["$rollingAvgSpeed", 2] }] }, true, false]
      }
    }
  },
  { $match: { speedAnomaly: true } }
])
```

## 📚 Documentation

| File | Purpose |
|------|---------|
| [README.md](README.md) | This file |
| [PROJECT_MAP.md](PROJECT_MAP.md) | Visual project structure |
| [docs/API_DOCS.md](docs/API_DOCS.md) | Complete API reference |
| [docs/SCHEMA.md](docs/SCHEMA.md) | MongoDB schema details |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Tuning guide |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues |
| [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md) | Oracle → MongoDB |

## 🐳 Docker Setup

Local testing with MongoDB:

```bash
npm run docker:up        # Start local MongoDB
npm run seed-data        # Seed documents
npm run start-api        # Start API
npm run docker:down      # Stop MongoDB
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Load testing
npm run test:load
```

## 🔧 Development

**VS Code Recommended Settings:**
- Auto-format on save
- ESLint integration
- Node.js debugging
- MongoDB extension

See `.vscode/settings.json` for pre-configured options.

## ⚙️ Configuration

Copy `.env.example` to `.env`:

```bash
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
DB_NAME=ship_tracking
PORT=3000
```

## 🛠️ Scripts

```bash
# Full setup
npm run setup

# Individual commands
npm run create-indexes
npm run seed-data
npm run start-api
npm run simulate-ingestion
npm run monitor

# Testing
npm run test
npm run test:load

# Docker
npm run docker:up
npm run docker:down

# Utility
npm run reset          # Clear database
npm run migrate        # Migration helper
```

## 📈 Monitoring

Real-time performance monitoring:

```bash
npm run monitor
```

Shows:
- Document count & size
- Index sizes
- Query latency metrics
- Configuration recommendations

## 🚨 Troubleshooting

**Q: Connection refused?**
- Check MongoDB Atlas URI in `.env`
- Verify IP whitelist in Atlas console

**Q: Low throughput?**
- Increase `maxPoolSize` in connection options
- Verify `BATCH_SIZE` and `CONCURRENT_BATCHES` settings
- Check network latency to MongoDB Atlas

**Q: High latency on geospatial queries?**
- Ensure 2dsphere index exists: `npm run create-indexes`
- Verify polygon GeoJSON format

## 📊 Next Steps for Production

1. **Security**
   - Enable IP whitelist
   - Use IAM authentication
   - Enable encryption in transit

2. **Scalability**
   - Enable sharding on `suid`
   - Set up read replicas
   - Add caching layer (Redis)

3. **Reliability**
   - Enable automated backups
   - Set up monitoring alerts
   - Configure multi-region replication

4. **Operations**
   - Add APM (DataDog, New Relic)
   - Document runbooks
   - Plan capacity upgrades

## 🤝 Contributing

Follow existing code style and add tests for new features.

## 📝 License

MIT

---

**Quick Links:**
- [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
- [MongoDB Driver for Node.js](https://www.mongodb.com/docs/drivers/node/)
- [Aggregation Pipeline Docs](https://docs.mongodb.com/manual/aggregation/)

**Support:**
For issues or questions, check [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
