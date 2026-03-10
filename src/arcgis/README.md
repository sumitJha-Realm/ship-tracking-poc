# ArcGIS Enterprise — Custom Data Feed for CTRACK MongoDB

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MongoDB (localhost:35010)                                   │
│  ├── ship_tracking.ctrack_data  (125,000 documents)         │
│  │   └── 2dsphere index on trackLocation                    │
│  └── ship_tracking.ship_remarks                             │
└──────────────────┬──────────────────────────────────────────┘
                   │
         ┌─────────▼─────────┐
         │  CDF Provider      │
         │  (Node.js Module)  │
         │                    │
         │  Reads MongoDB →   │
         │  Returns Esri JSON │
         └─────────┬──────────┘
                   │
    ┌──────────────▼──────────────┐
    │  ArcGIS Enterprise Server   │
    │                             │
    │  Registers CDF as a         │
    │  Feature Service:           │
    │  /arcgis/rest/services/     │
    │    CTRACK/FeatureServer      │
    └──────────────┬──────────────┘
                   │
    ┌──────────────▼──────────────┐
    │  Clients                    │
    │  ├── ArcGIS JS API (Web)    │
    │  ├── ArcGIS Pro (Desktop)   │
    │  ├── GeoEvent Server (RT)   │
    │  ├── ArcGIS Dashboards      │
    │  └── Experience Builder     │
    └─────────────────────────────┘
```

## Prerequisites

1. **ArcGIS Server** + **ArcGIS Enterprise SDK** installed
2. **Node.js** >= 16 (compatible with your ArcGIS release)
3. **MongoDB** instance at `localhost:35010` with:
   - Database: `ship_tracking`
   - Collection: `ctrack_data` (125,000 CTRACK documents)
   - Index: `2dsphere` on `trackLocation` field

## Files

```
src/arcgis/cdf-provider/
├── package.json               # Provider metadata + dependencies
├── config/
│   └── config.json            # MongoDB connection + feed settings
├── src/
│   ├── index.js               # CDF Provider interface (main entry)
│   ├── mongo-connector.js     # MongoDB queries + Decimal128 handling
│   ├── field-definitions.js   # CTRACK → Esri field schema (65 fields)
│   └── standalone-server.js   # Standalone Esri Feature Service server
```

---

## Path 1: Deploy to ArcGIS Enterprise Server (Production)

### Step 1: Copy provider to ArcGIS Server

```bash
# Copy the CDF provider to ArcGIS Server's custom data feeds directory
cp -r src/arcgis/cdf-provider /path/to/arcgis/server/framework/etc/customDataFeeds/ctrack-mongodb
```

### Step 2: Install dependencies

```bash
cd /path/to/arcgis/server/framework/etc/customDataFeeds/ctrack-mongodb
npm install
```

### Step 3: Register via ArcGIS Server Admin API

```bash
curl -X POST "https://your-arcgis-server:6443/arcgis/admin/services/createService" \
  -H "Content-Type: application/json" \
  -d '{
    "serviceName": "CTRACK_ShipTracking",
    "type": "FeatureServer",
    "description": "Real-time vessel tracking from CTRACK MongoDB",
    "capabilities": "Query",
    "properties": {
      "customDataFeedProvider": "ctrack-mongodb",
      "refreshInterval": 5
    }
  }'
```

### Step 4: Verify in ArcGIS Server Manager

1. Open ArcGIS Server Manager → Services
2. Verify **CTRACK_ShipTracking** is listed and running
3. Browse to: `https://your-server/arcgis/rest/services/CTRACK_ShipTracking/FeatureServer`

---

## Path 2: Standalone Feature Service (Development / Testing)

Run the CDF provider as an independent Esri-compatible REST server:

### Start the standalone server

```bash
cd src/arcgis/cdf-provider
npm install
node src/standalone-server.js
```

### Test endpoints

```bash
# Service info
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer?f=json"

# Layer info
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0?f=json"

# Query features (Esri JSON)
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=json&where=1=1&resultRecordCount=10"

# Query with filter
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=json&where=nationality=515&resultRecordCount=100"

# Spatial query (bounding box)
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=json&geometry=50,-30,90,10&resultRecordCount=500"

# GeoJSON format
curl "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=geojson&where=1=1&resultRecordCount=10"
```

---

## Path 3: Configure in ArcGIS GeoEvent Server (Real-Time)

### Register as Custom Data Feed in GeoEvent Manager

1. Open **GeoEvent Manager** → **Connectors**
2. Create new **Input Connector**: `Custom Data Feed (HTTP)`
3. Configure:
   - **URL**: `http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=json&where=1=1&resultRecordCount=5000`
   - **Polling Interval**: `5 seconds`
   - **Format**: `Esri Feature JSON`
   - **Track ID Field**: `suid`
   - **Geometry Field**: `geometry`

4. Create **Output Connector** to push to:
   - Stream Service (for real-time dashboard)
   - Feature Layer (for persistence)

### GeoEvent Service Configuration

```json
{
  "inputConnector": "CTRACK-MongoDB-Feed",
  "url": "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0/query",
  "parameters": {
    "f": "json",
    "where": "1=1",
    "resultRecordCount": 5000,
    "orderByFields": "reported_time_info DESC"
  },
  "pollingInterval": 5,
  "pollingIntervalUnit": "SECONDS",
  "trackIdField": "suid",
  "startTimeField": "reported_time_info"
}
```

---

## Using in ArcGIS JS API

```javascript
require([
  "esri/Map",
  "esri/views/MapView",
  "esri/layers/FeatureLayer"
], function(Map, MapView, FeatureLayer) {

  const shipLayer = new FeatureLayer({
    url: "http://localhost:3001/arcgis/rest/services/CTRACK/FeatureServer/0",
    refreshInterval: 0.1,  // minutes (6 seconds)
    outFields: ["*"],
    popupTemplate: {
      title: "{ship_name}",
      content: [
        { type: "fields", fieldInfos: [
          { fieldName: "suid", label: "SUID" },
          { fieldName: "mmsi_number", label: "MMSI" },
          { fieldName: "nationality", label: "Nationality" },
          { fieldName: "speed", label: "Speed (kn)" },
          { fieldName: "course", label: "Course" },
          { fieldName: "threat_score", label: "Threat Score" },
          { fieldName: "reported_time_info", label: "Reported" },
        ]}
      ]
    }
  });

  const map = new Map({ basemap: "dark-gray-vector", layers: [shipLayer] });
  const view = new MapView({ container: "viewDiv", map, center: [60, 10], zoom: 3 });
});
```

---

## Using in ArcGIS Pro

1. Open ArcGIS Pro → **Insert** → **Connections** → **New ArcGIS Server Connection**
2. Enter URL: `http://localhost:3001/arcgis/rest/services`
3. Browse to **CTRACK** → **FeatureServer**
4. Drag Layer 0 to the map

---

## CTRACK Field Schema (65 fields)

| Field | Esri Type | Description |
|-------|-----------|-------------|
| `suid` | String(64) | Unique ship identifier |
| `ship_name` | String(128) | Vessel name |
| `mmsi_number` | Double | MMSI number |
| `nationality` | Integer | MID nationality code |
| `ship_type` | Integer | AIS ship type (30-59) |
| `latitude` | Double | Current latitude |
| `longitude` | Double | Current longitude |
| `speed` | Double | Speed in knots |
| `course` | Double | Course over ground |
| `threat_score` | Integer | Threat score (0-100) |
| `vigilance_score` | Integer | Vigilance score |
| `reported_time_info` | Date | Last reported time |
| `sensor_type_list` | String | Sensor type |
| `color` | String | Nationality color hex |
| ... | ... | 51 more CTRACK fields |

## Nationality Color Coding

| Code | Color | Hex |
|------|-------|-----|
| 273 | Red | #FF0000 |
| 419 | Yellow | #e4e901 |
| 501 | Green | #00FF00 |
| 515 | Royal Blue | #4169E1 |
| 519 | Purple | #9370DB |
| ... | ... | 18 nationalities total |
