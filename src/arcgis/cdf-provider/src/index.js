/**
 * CTRACK MongoDB → ArcGIS Enterprise Custom Data Feed Provider
 *
 * This module implements the ArcGIS Enterprise Custom Data Feed (CDF) interface.
 * It reads real-time ship tracking data from MongoDB (ctrack_data collection)
 * and exposes it as an Esri Feature Service via ArcGIS Server.
 *
 * Prerequisites:
 *   - ArcGIS Server + ArcGIS Enterprise SDK installed
 *   - MongoDB on localhost:35010 with 2dsphere index on trackLocation
 *   - Node.js >= 16
 *
 * Registration:
 *   Copy this provider to: <ArcGIS Server install>/framework/etc/customDataFeeds/
 *   Or register via ArcGIS Server Admin API
 */

const config = require('../config/config.json');
const { FIELDS } = require('./field-definitions');
const mongo = require('./mongo-connector');

// ─── CDF Provider Implementation ─────────────────────────────────────

/**
 * Called once when ArcGIS Server loads this provider.
 * Establishes the MongoDB connection pool.
 */
async function initialize(params) {
  console.log('[CDF] Initializing CTRACK MongoDB provider...');
  console.log('[CDF] MongoDB URI:', config.mongodb.uri);
  console.log('[CDF] Database:', config.mongodb.database);
  console.log('[CDF] Collection:', config.mongodb.collection);

  await mongo.connect(config.mongodb);

  console.log('[CDF] Provider initialized successfully');
  return {
    name: config.feed.name,
    description: config.feed.description,
  };
}

/**
 * Called when ArcGIS Server shuts down or unloads the provider.
 */
async function shutdown() {
  console.log('[CDF] Shutting down CTRACK MongoDB provider...');
  await mongo.disconnect();
}

/**
 * Returns the service metadata (layer info).
 * ArcGIS Server uses this to expose the Feature Service schema.
 */
function getServiceInfo() {
  return {
    // Layer 0: Ship tracks
    layers: [
      {
        id: 0,
        name: config.feed.name,
        description: config.feed.description,
        type: 'Feature Layer',
        geometryType: 'esriGeometryPoint',
        objectIdField: config.feed.objectIdField,
        displayField: config.feed.displayField,
        spatialReference: { wkid: config.feed.spatialReference },
        maxRecordCount: config.feed.maxRecordCount,
        fields: FIELDS,
        capabilities: 'Query',
        supportsStatistics: true,
        supportsPagination: true,
        supportsOrderBy: true,
        // Drawing info for default renderer
        drawingInfo: {
          renderer: {
            type: 'uniqueValue',
            field1: 'nationality',
            defaultSymbol: {
              type: 'esriSMS',
              style: 'esriSMSCircle',
              color: [255, 255, 255, 200],
              size: 6,
              outline: { color: [0, 0, 0, 255], width: 1 },
            },
            uniqueValueInfos: buildNationalityRenderer(),
          },
        },
        // Time info for real-time/temporal queries
        timeInfo: {
          startTimeField: 'reported_time_info',
          trackIdField: 'suid',
          timeInterval: config.feed.refreshIntervalSeconds,
          timeIntervalUnits: 'esriTimeUnitsSeconds',
        },
      },
    ],
  };
}

/**
 * Build unique value renderer entries for nationality colors
 */
function buildNationalityRenderer() {
  const { NATIONALITY_COLORS } = require('./field-definitions');
  return Object.entries(NATIONALITY_COLORS).map(([code, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return {
      value: parseInt(code),
      label: `Nationality ${code}`,
      symbol: {
        type: 'esriSMS',
        style: 'esriSMSCircle',
        color: [r, g, b, 220],
        size: 7,
        outline: { color: [0, 0, 0, 255], width: 1 },
      },
    };
  });
}

/**
 * Query handler — the core CDF method.
 * ArcGIS Server calls this for every feature query.
 *
 * @param {Object} query - Esri query object
 * @param {string} query.where - SQL-like where clause
 * @param {Object} query.geometry - Spatial filter envelope
 * @param {string} query.outFields - Comma-separated field names or '*'
 * @param {boolean} query.returnCountOnly
 * @param {boolean} query.returnGeometry
 * @param {number} query.resultOffset
 * @param {number} query.resultRecordCount
 * @param {string} query.orderByFields - e.g. 'reported_time_info DESC'
 */
async function getFeatures(query = {}) {
  const startTime = Date.now();

  const options = {
    where: query.where || '1=1',
    geometry: query.geometry || null,
    limit: query.resultRecordCount || config.feed.defaultLimit,
    offset: query.resultOffset || 0,
    orderBy: query.orderByFields || 'reported_time_info DESC',
    returnCountOnly: query.returnCountOnly || false,
  };

  const { features, count } = await mongo.queryFeatures(options);
  const duration = Date.now() - startTime;

  console.log(`[CDF] Query: where="${options.where}" limit=${options.limit} offset=${options.offset} → ${features.length} features (${duration}ms)`);

  // Return in Esri Feature Set format
  return {
    objectIdFieldName: config.feed.objectIdField,
    globalIdFieldName: '',
    geometryType: 'esriGeometryPoint',
    spatialReference: { wkid: config.feed.spatialReference },
    fields: query.returnCountOnly ? [] : FIELDS,
    features: query.returnCountOnly ? [] : features,
    count: count,
    exceededTransferLimit: features.length >= options.limit,
  };
}

/**
 * Returns the spatial extent of all features.
 */
async function getExtent() {
  return await mongo.getExtent();
}

/**
 * Returns the total feature count.
 */
async function getFeatureCount(query = {}) {
  const { count } = await mongo.queryFeatures({
    where: query.where || '1=1',
    geometry: query.geometry || null,
    returnCountOnly: true,
  });
  return count;
}

// ─── Export CDF Interface ────────────────────────────────────────────

module.exports = {
  initialize,
  shutdown,
  getServiceInfo,
  getFeatures,
  getExtent,
  getFeatureCount,
};
