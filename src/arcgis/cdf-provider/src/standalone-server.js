/**
 * Standalone Esri Feature Service Server
 *
 * Runs the CDF provider as an independent REST service that exposes
 * Esri-compatible Feature Service endpoints. Use this when you want to:
 *
 *   1. Test the CDF provider locally before deploying to ArcGIS Enterprise
 *   2. Use as a direct Feature Service URL in ArcGIS JS API / ArcGIS Pro
 *   3. Configure as a Custom Data Feed URL in ArcGIS GeoEvent Server
 *
 * Endpoints:
 *   GET /arcgis/rest/services/CTRACK/FeatureServer        → Service info
 *   GET /arcgis/rest/services/CTRACK/FeatureServer/0      → Layer info
 *   GET /arcgis/rest/services/CTRACK/FeatureServer/0/query → Query features
 *
 * Usage:
 *   node src/arcgis/cdf-provider/src/standalone-server.js
 */

const express = require('express');
const cors = require('cors');
const cdf = require('./index');
const config = require('../config/config.json');

const app = express();
const PORT = process.env.CDF_PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── Service root ────────────────────────────────────────────────────
app.get('/arcgis/rest/services/CTRACK/FeatureServer', (req, res) => {
  const info = cdf.getServiceInfo();
  const response = {
    currentVersion: 11.2,
    serviceDescription: config.feed.description,
    hasVersionedData: false,
    supportsDisconnectedEditing: false,
    supportedQueryFormats: 'JSON,geoJSON',
    maxRecordCount: config.feed.maxRecordCount,
    capabilities: 'Query',
    description: config.feed.description,
    spatialReference: { wkid: config.feed.spatialReference },
    initialExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
    fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
    layers: info.layers.map(l => ({ id: l.id, name: l.name, type: l.type, geometryType: l.geometryType })),
    tables: [],
  };
  if (req.query.f === 'json' || req.query.f === 'pjson') {
    return res.json(response);
  }
  res.json(response);
});

// ─── Layer info ──────────────────────────────────────────────────────
app.get('/arcgis/rest/services/CTRACK/FeatureServer/0', async (req, res) => {
  const info = cdf.getServiceInfo();
  const layer = info.layers[0];
  const extent = await cdf.getExtent();
  const count = await cdf.getFeatureCount();

  res.json({
    currentVersion: 11.2,
    ...layer,
    extent,
    count,
    hasAttachments: false,
    htmlPopupType: 'esriServerHTMLPopupTypeAsHTMLText',
    hasM: false,
    hasZ: false,
    typeIdField: null,
    types: [],
    relationships: [],
    advancedQueryCapabilities: {
      supportsStatistics: true,
      supportsPagination: true,
      supportsOrderBy: true,
      supportsDistinct: false,
      supportsReturningQueryExtent: true,
    },
  });
});

// ─── Query features ──────────────────────────────────────────────────
app.get('/arcgis/rest/services/CTRACK/FeatureServer/0/query', async (req, res) => {
  try {
    const query = {
      where: req.query.where || '1=1',
      outFields: req.query.outFields || '*',
      returnGeometry: req.query.returnGeometry !== 'false',
      returnCountOnly: req.query.returnCountOnly === 'true',
      resultOffset: parseInt(req.query.resultOffset) || 0,
      resultRecordCount: parseInt(req.query.resultRecordCount) || config.feed.defaultLimit,
      orderByFields: req.query.orderByFields || 'reported_time_info DESC',
    };

    // Parse geometry envelope if provided
    if (req.query.geometry) {
      try {
        const geom = JSON.parse(req.query.geometry);
        query.geometry = geom;
      } catch (e) {
        // Try parsing as xmin,ymin,xmax,ymax
        const parts = req.query.geometry.split(',').map(Number);
        if (parts.length === 4) {
          query.geometry = { xmin: parts[0], ymin: parts[1], xmax: parts[2], ymax: parts[3] };
        }
      }
    }

    // Format
    const format = req.query.f || 'json';

    const result = await cdf.getFeatures(query);

    if (format === 'geojson') {
      // Convert to GeoJSON
      const geojson = {
        type: 'FeatureCollection',
        features: result.features.map(f => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [f.geometry.x, f.geometry.y] },
          properties: f.attributes,
        })),
      };
      return res.json(geojson);
    }

    res.json(result);
  } catch (error) {
    console.error('[CDF-Server] Query error:', error.message);
    res.status(500).json({ error: { code: 500, message: error.message } });
  }
});

// ─── Extent ──────────────────────────────────────────────────────────
app.get('/arcgis/rest/services/CTRACK/FeatureServer/0/query/extent', async (req, res) => {
  const extent = await cdf.getExtent();
  res.json({ extent, count: await cdf.getFeatureCount() });
});

// ─── Health ──────────────────────────────────────────────────────────
app.get('/arcgis/rest/info', (req, res) => {
  res.json({
    currentVersion: 11.2,
    fullVersion: '11.2.0',
    owningSystemUrl: `http://localhost:${PORT}/arcgis`,
    authInfo: { isTokenBasedSecurity: false },
  });
});

// ─── Start ───────────────────────────────────────────────────────────
async function start() {
  try {
    await cdf.initialize();
    app.listen(PORT, () => {
      console.log(`\n[CDF-Server] CTRACK Feature Service running on port ${PORT}`);
      console.log('[CDF-Server] Endpoints:');
      console.log(`  Service:  http://localhost:${PORT}/arcgis/rest/services/CTRACK/FeatureServer`);
      console.log(`  Layer 0:  http://localhost:${PORT}/arcgis/rest/services/CTRACK/FeatureServer/0`);
      console.log(`  Query:    http://localhost:${PORT}/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=json&where=1=1&resultRecordCount=10`);
      console.log(`  GeoJSON:  http://localhost:${PORT}/arcgis/rest/services/CTRACK/FeatureServer/0/query?f=geojson&where=1=1&resultRecordCount=10`);
      console.log(`\n[CDF-Server] Use this URL in ArcGIS Enterprise / GeoEvent Server:`);
      console.log(`  http://localhost:${PORT}/arcgis/rest/services/CTRACK/FeatureServer\n`);
    });
  } catch (error) {
    console.error('[CDF-Server] Failed to start:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => { await cdf.shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await cdf.shutdown(); process.exit(0); });

start();
