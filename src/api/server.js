const express = require('express');
const path = require('path');
const { ObjectId } = require('mongodb');
const { spawn } = require('child_process');
const { connect, getCollection, getRemarksCollection, getTimeseriesCollection, getCtrackDb, getDb, disconnect } = require('../utils/db');
const logger = require('../utils/logger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── GeoJSON Cache (avoids re-running full pipeline on every load) ─────
let _geojsonCache = null;
let _geojsonCacheTime = 0;
const GEOJSON_CACHE_TTL_MS = 5000; // 5 seconds

// ─── Query Log (in-memory ring buffer) ───────────────────────────────
const QUERY_LOG_MAX = 150;
const queryLog = [];
let querySeq = 0;

function logQuery({ endpoint, method, collection, operation, query, sort, limit, skip, projection, duration_ms, result_count, index_used }) {
  querySeq++;
  const entry = {
    id: querySeq,
    timestamp: new Date().toISOString(),
    endpoint,
    method: method || 'GET',
    collection,
    operation,
    query: query || {},
    sort: sort || null,
    limit: limit || null,
    skip: skip || null,
    projection: projection || null,
    duration_ms,
    result_count,
    index_used: index_used || null,
  };
  queryLog.push(entry);
  if (queryLog.length > QUERY_LOG_MAX) queryLog.shift();
}

// ─── Serve static files from /public ─────────────────────────────────
app.use(express.static(path.join(__dirname, '../../public')));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug('API', `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ─── Color mapping by nationality (CTRACK nationality codes) ─────────
const NATIONALITY_COLORS = {
  273: '#FF0000',  // Red
  419: '#e4e901',  // Yellow
  501: '#00FF00',  // Green
  502: '#FF8C00',  // Orange
  503: '#1E90FF',  // Dodger Blue
  504: '#800080',  // Purple
  505: '#00CED1',  // Teal
  506: '#FF69B4',  // Pink
  508: '#8B4513',  // Brown
  510: '#4682B4',  // Steel Blue
  511: '#32CD32',  // Lime Green
  512: '#DC143C',  // Crimson
  514: '#FF4500',  // Orange Red
  515: '#4169E1',  // Royal Blue
  516: '#2E8B57',  // Sea Green
  518: '#DAA520',  // Goldenrod
  519: '#9370DB',  // Medium Purple
  520: '#20B2AA',  // Light Sea Green
  538: '#F0E68C',  // Khaki (Marshall Islands)
};

function buildColorConditions() {
  const branches = Object.entries(NATIONALITY_COLORS).map(([code, color]) => ({
    case: { $eq: ['$nationality', parseInt(code)] },
    then: color,
  }));

  return {
    $switch: {
      branches,
      default: '#FFFFFF',
    },
  };
}

// ─── GET /tracks ─────────────────────────────────────────────────────
// Get all ship tracks with color logic and user-specific flags
app.get('/tracks', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'] || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 10000);
    const skip = parseInt(req.query.skip) || 0;
    const nationality = req.query.nationality ? parseInt(req.query.nationality) : null;
    const shipType = req.query.ship_type ? parseInt(req.query.ship_type) : null;
    const timeFrom = req.query.time_from || null;
    const timeTo = req.query.time_to || null;
    const sortBy = req.query.sort || 'reported_time_info';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    // Build match stage
    const matchStage = {};
    if (nationality) matchStage.nationality = nationality;
    if (shipType) matchStage['vessel_info.ship_type'] = shipType;

    // Time range filter on reported_time_info
    if (timeFrom || timeTo) {
      matchStage.reported_time_info = {};
      if (timeFrom) matchStage.reported_time_info.$gte = new Date(timeFrom);
      if (timeTo) matchStage.reported_time_info.$lte = new Date(timeTo);
    }

    const pipeline = [];

    // Match filter
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // Sort
    pipeline.push({ $sort: { [sortBy]: sortOrder } });

    // Pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });

    // Add computed fields (color, TOI flag, remark flag)
    const addFieldsStage = {
      color: buildColorConditions(),
    };

    if (userId) {
      addFieldsStage.IS_TOI = {
        $cond: [{ $in: [userId, { $ifNull: ['$TOIUserIds', []] }] }, 1, 0],
      };
      addFieldsStage.IS_REMARK = {
        $cond: [{ $in: [userId, { $ifNull: ['$CtrackRemarksUserIDs', []] }] }, 1, 0],
      };
    } else {
      addFieldsStage.IS_TOI = 0;
      addFieldsStage.IS_REMARK = 0;
    }

    pipeline.push({ $addFields: addFieldsStage });

    // Project out internal arrays
    pipeline.push({
      $project: {
        _id: 0,
        TOIUserIds: 0,
        CtrackRemarksUserIDs: 0,
      },
    });

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    logQuery({ endpoint: '/tracks', collection: 'ctrack_data', operation: 'aggregate', query: matchStage, sort: { [sortBy]: sortOrder }, limit, skip, duration_ms: duration, result_count: data.length, index_used: nationality ? 'idx_nationality' : shipType ? 'idx_vessel_ship_type' : 'idx_reported_time_desc' });
    logger.info('API', `GET /tracks - ${data.length} results in ${duration}ms`);

    res.json({
      success: true,
      count: data.length,
      query_time_ms: duration,
      data,
    });
  } catch (error) {
    logger.error('API', 'GET /tracks failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/overlay ─────────────────────────────────────────────
// Find ships within a GeoJSON polygon (GET with query param)
app.get('/tracks/overlay', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'] || null;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 50000);

    let polygon;
    try {
      polygon = JSON.parse(req.query.polygon);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid polygon GeoJSON. Provide a valid GeoJSON Polygon as query parameter.',
        example: {
          type: 'Polygon',
          coordinates: [[[50, -30], [50, 10], [90, 10], [90, -30], [50, -30]]],
        },
      });
    }

    if (!polygon || polygon.type !== 'Polygon' || !polygon.coordinates) {
      return res.status(400).json({
        success: false,
        error: 'polygon must be a valid GeoJSON Polygon with type and coordinates',
      });
    }

    const pipeline = [
      {
        $match: {
          trackLocation: {
            $geoWithin: {
              $geometry: polygon,
            },
          },
        },
      },
      { $limit: limit },
      {
        $addFields: {
          color: buildColorConditions(),
          IS_TOI: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$TOIUserIds', []] }] }, 1, 0] }
            : 0,
          IS_REMARK: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$CtrackRemarksUserIDs', []] }] }, 1, 0] }
            : 0,
        },
      },
      {
        $project: {
          _id: 0,
          TOIUserIds: 0,
          CtrackRemarksUserIDs: 0,
        },
      },
    ];

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    logQuery({ endpoint: '/tracks/overlay', collection: 'ctrack_data', operation: 'aggregate($geoWithin)', query: { trackLocation: { $geoWithin: { $geometry: 'Polygon(...)' } } }, limit, duration_ms: duration, result_count: data.length, index_used: 'idx_trackLocation_2dsphere' });
    logger.info('API', `GET /tracks/overlay - ${data.length} results in ${duration}ms`);

    res.json({
      success: true,
      count: data.length,
      query_time_ms: duration,
      data,
    });
  } catch (error) {
    logger.error('API', 'GET /tracks/overlay failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /tracks/overlay ────────────────────────────────────────────
// Find ships within a GeoJSON polygon (POST with JSON body — easier for UI)
app.post('/tracks/overlay', async (req, res) => {
  try {
    const collection = await getCollection();
    const limit = Math.min(parseInt(req.query.limit) || 5000, 50000);
    const polygon = req.body.polygon;

    if (!polygon || polygon.type !== 'Polygon' || !polygon.coordinates) {
      return res.status(400).json({
        success: false,
        error: 'Request body must include polygon: { type: "Polygon", coordinates: [...] }',
      });
    }

    const pipeline = [
      { $match: { trackLocation: { $geoWithin: { $geometry: polygon } } } },
      { $limit: limit },
      { $addFields: { color: buildColorConditions() } },
      { $project: { _id: 0, TOIUserIds: 0, CtrackRemarksUserIDs: 0, trackLocation: 0, contriburtion: 0, station_contriburtion: 0, pans_info: 0, surv_oc_id: 0, vessel_info: 0 } },
    ];

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    const toLong = v => (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : v;
    data.forEach(doc => {
      ['nationality','mmsi_number','course','threat_score','interface_sensor_type'].forEach(k => {
        if (doc[k] != null) doc[k] = toLong(doc[k]);
      });
    });

    logQuery({ endpoint: 'POST /tracks/overlay', method: 'POST', collection: 'ctrack_data', operation: 'aggregate($geoWithin)', query: { trackLocation: { $geoWithin: { $geometry: 'Polygon(...)' } } }, limit, duration_ms: duration, result_count: data.length, index_used: 'idx_trackLocation_2dsphere' });
    logger.info('API', `POST /tracks/overlay - ${data.length} results in ${duration}ms`);
    res.json({ success: true, count: data.length, query_time_ms: duration, data });
  } catch (error) {
    logger.error('API', 'POST /tracks/overlay failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/stats ───────────────────────────────────────────────
// Aggregate statistics
app.get('/tracks/stats', async (req, res) => {
  try {
    const collection = await getCollection();

    const startTime = Date.now();

    const pipeline = [
      {
        $facet: {
          totalCount: [{ $count: 'count' }],
          byNationality: [
            { $group: { _id: '$nationality', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
          ],
          byShipType: [
            { $group: { _id: { $arrayElemAt: ['$vessel_info.ship_type', 0] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          byThreatScore: [
            { $bucket: {
              groupBy: '$threat_score',
              boundaries: [0, 20, 40, 60, 80, 100],
              default: 'Other',
              output: { count: { $sum: 1 } },
            }},
          ],
          byRemarks: [
            { $group: { _id: '$remarks', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
          bySensorType: [
            { $group: { _id: '$interface_sensor_type', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          speedStats: [
            {
              $group: {
                _id: null,
                avgSpeed: { $avg: '$speed' },
                maxSpeed: { $max: '$speed' },
                minSpeed: { $min: '$speed' },
              },
            },
          ],
          recentUpdates: [
            { $sort: { reported_time_info: -1 } },
            { $limit: 5 },
            {
              $project: {
                _id: 0,
                suid: 1,
                ship_name: 1,
                nationality: 1,
                reported_time_info: 1,
              },
            },
          ],
        },
      },
    ];

    const [result] = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    const stats = {
      total_documents: result.totalCount[0]?.count || 0,
      by_nationality: result.byNationality,
      by_ship_type: result.byShipType,
      by_threat_score: result.byThreatScore,
      by_remarks: result.byRemarks,
      by_sensor_type: result.bySensorType,
      speed_stats: result.speedStats[0] || {},
      recent_updates: result.recentUpdates,
    };

    logQuery({ endpoint: '/tracks/stats', collection: 'ctrack_data', operation: 'aggregate($facet)', query: { $facet: '6 pipelines' }, duration_ms: duration, result_count: 1, index_used: 'multiple' });
    logger.info('API', `GET /tracks/stats - completed in ${duration}ms`);

    res.json({
      success: true,
      query_time_ms: duration,
      data: stats,
    });
  } catch (error) {
    logger.error('API', 'GET /tracks/stats failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/my-toi ─────────────────────────────────────────────
// Get all ships marked as Track of Interest by the current user
app.get('/tracks/my-toi', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);

    const pipeline = [
      { $match: { TOIUserIds: userId } },
      { $sort: { reported_time_info: -1 } },
      { $limit: limit },
      {
        $addFields: {
          color: buildColorConditions(),
          IS_TOI: 1,
          IS_REMARK: {
            $cond: [{ $in: [userId, { $ifNull: ['$CtrackRemarksUserIDs', []] }] }, 1, 0],
          },
        },
      },
      { $project: { _id: 0, TOIUserIds: 0, CtrackRemarksUserIDs: 0 } },
    ];

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    logQuery({ endpoint: '/tracks/my-toi', collection: 'ctrack_data', operation: 'aggregate(match)', query: { TOIUserIds: userId }, sort: { reported_time_info: -1 }, limit, duration_ms: duration, result_count: data.length, index_used: 'collection_scan(TOIUserIds)' });
    logger.info('API', `GET /tracks/my-toi - ${data.length} results in ${duration}ms (user: ${userId})`);

    res.json({ success: true, count: data.length, query_time_ms: duration, data });
  } catch (error) {
    logger.error('API', 'GET /tracks/my-toi failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/my-remarks ─────────────────────────────────────────
// Get all ships remarked by the current user
app.get('/tracks/my-remarks', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);

    const pipeline = [
      { $match: { CtrackRemarksUserIDs: userId } },
      { $sort: { reported_time_info: -1 } },
      { $limit: limit },
      {
        $addFields: {
          color: buildColorConditions(),
          IS_TOI: {
            $cond: [{ $in: [userId, { $ifNull: ['$TOIUserIds', []] }] }, 1, 0],
          },
          IS_REMARK: 1,
        },
      },
      { $project: { _id: 0, TOIUserIds: 0, CtrackRemarksUserIDs: 0 } },
    ];

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    logger.info('API', `GET /tracks/my-remarks - ${data.length} results in ${duration}ms (user: ${userId})`);

    res.json({ success: true, count: data.length, query_time_ms: duration, data });
  } catch (error) {
    logger.error('API', 'GET /tracks/my-remarks failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/nearby ────────────────────────────────────────────
// Find ships near a lat/lng point within radius (km)
app.get('/tracks/nearby', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'] || null;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusKm = parseFloat(req.query.radius) || 100;
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ success: false, error: 'lat and lng query params required' });
    }

    const pipeline = [
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distance_m',
          maxDistance: radiusKm * 1000,
          spherical: true,
        },
      },
      { $limit: limit },
      {
        $addFields: {
          distance_km: { $round: [{ $divide: ['$distance_m', 1000] }, 2] },
          color: buildColorConditions(),
          IS_TOI: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$TOIUserIds', []] }] }, 1, 0] }
            : 0,
          IS_REMARK: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$CtrackRemarksUserIDs', []] }] }, 1, 0] }
            : 0,
        },
      },
      { $project: { _id: 0, TOIUserIds: 0, CtrackRemarksUserIDs: 0 } },
    ];

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    logQuery({ endpoint: '/tracks/nearby', collection: 'ctrack_data', operation: 'aggregate($geoNear)', query: { near: [lng, lat], maxDistance: radiusKm * 1000 }, limit, duration_ms: duration, result_count: data.length, index_used: 'idx_trackLocation_2dsphere' });
    logger.info('API', `GET /tracks/nearby - ${data.length} results in ${duration}ms (${lat},${lng} r=${radiusKm}km)`);
    res.json({ success: true, count: data.length, query_time_ms: duration, center: { lat, lng }, radius_km: radiusKm, data });
  } catch (error) {
    logger.error('API', 'GET /tracks/nearby failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/:suid/remarks ─────────────────────────────────────
// Get all remarks for a ship from ship_remarks collection
app.get('/tracks/:suid/remarks', async (req, res) => {
  try {
    const remarksCol = await getRemarksCollection();
    const startTime = Date.now();
    const data = await remarksCol
      .find({ suid: req.params.suid })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    const duration = Date.now() - startTime;

    logQuery({ endpoint: '/tracks/:suid/remarks', collection: 'ship_remarks', operation: 'find+sort', query: { suid: req.params.suid }, sort: { created_at: -1 }, limit: 200, duration_ms: duration, result_count: data.length });
    logger.info('API', `GET /tracks/${req.params.suid}/remarks - ${data.length} in ${duration}ms`);
    res.json({ success: true, count: data.length, query_time_ms: duration, data });
  } catch (error) {
    logger.error('API', 'GET /tracks/:suid/remarks failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /tracks/:suid/remarks ────────────────────────────────────
// Add a new remark for a ship
app.post('/tracks/:suid/remarks', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }
    const text = (req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, error: 'text field required in body' });
    }

    // Verify ship exists
    const collection = await getCollection();
    const ship = await collection.findOne({ suid: req.params.suid }, { projection: { ship_name: 1 } });
    if (!ship) {
      return res.status(404).json({ success: false, error: 'Ship not found' });
    }

    const remarksCol = await getRemarksCollection();
    const doc = {
      suid: req.params.suid,
      ship_name: ship.ship_name || '',
      user_id: userId,
      text: text,
      created_at: new Date(),
    };
    const remarkStart = Date.now();
    const result = await remarksCol.insertOne(doc);
    const remarkDur = Date.now() - remarkStart;

    logQuery({ endpoint: 'POST /tracks/:suid/remarks', method: 'POST', collection: 'ship_remarks', operation: 'insertOne', query: { suid: req.params.suid, user_id: userId, text: text.slice(0, 40) + '...' }, duration_ms: remarkDur, result_count: 1 });
    logger.info('API', `POST /tracks/${req.params.suid}/remarks - added by ${userId}`);
    res.json({ success: true, remark_id: result.insertedId, data: doc });
  } catch (error) {
    logger.error('API', 'POST /tracks/:suid/remarks failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── DELETE /tracks/:suid/remarks/:remarkId ───────────────────────
// Delete a remark
app.delete('/tracks/:suid/remarks/:remarkId', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }
    const remarksCol = await getRemarksCollection();
    const delStart = Date.now();
    const result = await remarksCol.deleteOne({
      _id: new ObjectId(req.params.remarkId),
      suid: req.params.suid,
      user_id: userId,
    });
    const delDur = Date.now() - delStart;
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'Remark not found or not yours' });
    }
    logQuery({ endpoint: 'DELETE /tracks/:suid/remarks/:id', method: 'DELETE', collection: 'ship_remarks', operation: 'deleteOne', query: { _id: req.params.remarkId, suid: req.params.suid, user_id: userId }, duration_ms: delDur, result_count: result.deletedCount });
    logger.info('API', `DELETE remark ${req.params.remarkId} by ${userId}`);
    res.json({ success: true, deleted: req.params.remarkId });
  } catch (error) {
    logger.error('API', 'DELETE remark failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /tracks/:suid ──────────────────────────────────────────────
// Get a single ship by suid
app.get('/tracks/:suid', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'] || null;

    const pipeline = [
      { $match: { suid: req.params.suid } },
      {
        $addFields: {
          color: buildColorConditions(),
          IS_TOI: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$TOIUserIds', []] }] }, 1, 0] }
            : 0,
          IS_REMARK: userId
            ? { $cond: [{ $in: [userId, { $ifNull: ['$CtrackRemarksUserIDs', []] }] }, 1, 0] }
            : 0,
        },
      },
      { $project: { _id: 0, TOIUserIds: 0, CtrackRemarksUserIDs: 0 } },
    ];

    const startTime = Date.now();
    const [data] = await collection.aggregate(pipeline).toArray();
    const duration = Date.now() - startTime;

    if (!data) {
      return res.status(404).json({ success: false, error: 'Ship not found' });
    }

    logQuery({ endpoint: '/tracks/:suid', collection: 'ctrack_data', operation: 'aggregate(match)', query: { suid: req.params.suid }, duration_ms: duration, result_count: data ? 1 : 0, index_used: 'idx_suid_unique' });
    res.json({ success: true, query_time_ms: duration, data });
  } catch (error) {
    logger.error('API', `GET /tracks/:suid failed:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /tracks/:suid/toi ─────────────────────────────────────────
// Toggle Track of Interest for a user
app.post('/tracks/:suid/toi', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }

    const ship = await collection.findOne({ suid: req.params.suid });
    if (!ship) {
      return res.status(404).json({ success: false, error: 'Ship not found' });
    }

    const isCurrentlyTOI = (ship.TOIUserIds || []).includes(userId);
    const update = isCurrentlyTOI
      ? { $pull: { TOIUserIds: userId } }
      : { $addToSet: { TOIUserIds: userId } };

    const toiStart = Date.now();
    await collection.updateOne({ suid: req.params.suid }, update);
    const toiDur = Date.now() - toiStart;

    const action = isCurrentlyTOI ? 'removed' : 'added';
    logQuery({ endpoint: 'POST /tracks/:suid/toi', method: 'POST', collection: 'ctrack_data', operation: 'updateOne(' + (isCurrentlyTOI ? '$pull' : '$addToSet') + ')', query: { suid: req.params.suid, TOIUserIds: userId, action }, duration_ms: toiDur, result_count: 1, index_used: 'idx_suid_unique' });

    res.json({
      success: true,
      action,
      suid: req.params.suid,
      userId,
    });
  } catch (error) {
    logger.error('API', 'POST /tracks/:suid/toi failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── POST /tracks/:suid/remark ──────────────────────────────────────
// Toggle remark flag for a user
app.post('/tracks/:suid/remark', async (req, res) => {
  try {
    const collection = await getCollection();
    const userId = req.headers['x-user-id'];

    if (!userId) {
      return res.status(400).json({ success: false, error: 'x-user-id header required' });
    }

    const ship = await collection.findOne({ suid: req.params.suid });
    if (!ship) {
      return res.status(404).json({ success: false, error: 'Ship not found' });
    }

    const hasRemark = (ship.CtrackRemarksUserIDs || []).includes(userId);
    const update = hasRemark
      ? { $pull: { CtrackRemarksUserIDs: userId } }
      : { $addToSet: { CtrackRemarksUserIDs: userId } };

    const rmkStart = Date.now();
    await collection.updateOne({ suid: req.params.suid }, update);
    const rmkDur = Date.now() - rmkStart;

    const rmkAction = hasRemark ? 'removed' : 'added';
    logQuery({ endpoint: 'POST /tracks/:suid/remark', method: 'POST', collection: 'ctrack_data', operation: 'updateOne(' + (hasRemark ? '$pull' : '$addToSet') + ')', query: { suid: req.params.suid, CtrackRemarksUserIDs: userId, action: rmkAction }, duration_ms: rmkDur, result_count: 1, index_used: 'idx_suid_unique' });

    res.json({
      success: true,
      action: rmkAction,
      suid: req.params.suid,
      userId,
    });
  } catch (error) {
    logger.error('API', 'POST /tracks/:suid/remark failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /feed/geojson ──────────────────────────────────────────────
// GeoJSON FeatureCollection feed — OPTIMIZED with cache + lean projection
//
// Optimizations:
//  1. Server-side TTL cache (5s) — skip DB entirely on repeat loads
//  2. Lean $project early — only 12 fields vs full 60+ field document
//  3. Color computed in JS (O(1) hash lookup) instead of $switch with 19 branches
//  4. No $addFields/$switch stage — fewer aggregation passes
//  5. Hint idx_reported_time_desc for guaranteed index-backed sort

const NATIONALITY_COLOR_MAP = {};
Object.entries(NATIONALITY_COLORS).forEach(([code, color]) => {
  NATIONALITY_COLOR_MAP[parseInt(code)] = color;
});
const toLongNum = v => (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : v;

app.get('/feed/geojson', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5000, 50000);
    const nationality = req.query.nationality ? parseInt(req.query.nationality) : null;
    const shipType = req.query.ship_type ? parseInt(req.query.ship_type) : null;
    const hasFilters = !!(nationality || shipType);

    // Cache check (unfiltered default loads only)
    const now = Date.now();
    if (!hasFilters && _geojsonCache && (now - _geojsonCacheTime) < GEOJSON_CACHE_TTL_MS && _geojsonCache._limit === limit) {
      logQuery({ endpoint: '/feed/geojson', collection: 'ctrack_data', operation: 'CACHE HIT', query: {}, duration_ms: 0, result_count: _geojsonCache.features.length, index_used: 'server_cache(5s TTL)' });
      return res.json(_geojsonCache);
    }

    const collection = await getCollection();
    const matchStage = {};
    if (nationality) matchStage.nationality = nationality;
    if (shipType) matchStage['vessel_info.ship_type'] = shipType;

    // Lean pipeline — project only what the map needs
    const pipeline = [];
    if (hasFilters) pipeline.push({ $match: matchStage });
    pipeline.push({ $sort: { reported_time_info: -1 } });
    pipeline.push({ $limit: limit });
    pipeline.push({ $project: {
      _id: 0, suid: 1, ship_name: 1, latitude: 1, longitude: 1,
      speed: 1, course: 1, nationality: 1, mmsi_number: 1,
      threat_score: 1, reported_time_info: 1, interface_sensor_type: 1,
      'vessel_info.ship_type': 1,
    } });

    const startTime = Date.now();
    const data = await collection.aggregate(pipeline, { hint: hasFilters ? undefined : 'idx_reported_time_desc' }).toArray();
    const duration = Date.now() - startTime;

    // Build GeoJSON with JS-side color (fast hash lookup vs 19-branch $switch)
    const features = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const doc = data[i];
      const nat = toLongNum(doc.nationality);
      features[i] = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [doc.longitude || 0, doc.latitude || 0] },
        properties: {
          suid: doc.suid, ship_name: doc.ship_name,
          latitude: doc.latitude, longitude: doc.longitude,
          speed: doc.speed, course: toLongNum(doc.course),
          nationality: nat, mmsi_number: toLongNum(doc.mmsi_number),
          threat_score: toLongNum(doc.threat_score),
          interface_sensor_type: toLongNum(doc.interface_sensor_type),
          ship_type: doc.vessel_info?.[0]?.ship_type != null ? toLongNum(doc.vessel_info[0].ship_type) : null,
          reported_time_info: doc.reported_time_info,
          color: NATIONALITY_COLOR_MAP[nat] || '#FFFFFF',
        },
      };
    }

    const result = {
      type: 'FeatureCollection',
      metadata: { count: features.length, query_time_ms: duration, generated: new Date().toISOString(), cached: false },
      features,
      _limit: limit,
    };

    // Cache unfiltered results
    if (!hasFilters) {
      _geojsonCache = { ...result, metadata: { ...result.metadata, cached: true } };
      _geojsonCacheTime = now;
    }

    logQuery({ endpoint: '/feed/geojson', collection: 'ctrack_data', operation: 'aggregate(lean)', query: matchStage, sort: { reported_time_info: -1 }, limit, duration_ms: duration, result_count: features.length, index_used: hasFilters ? 'idx_nationality/idx_vessel_ship_type' : 'idx_reported_time_desc(hinted)' });
    logger.info('API', `GET /feed/geojson - ${features.length} features in ${duration}ms`);
    res.json(result);
  } catch (error) {
    logger.error('API', 'GET /feed/geojson failed:', error.message);
    res.status(500).json({ type: 'FeatureCollection', features: [], error: error.message });
  }
});

// ─── GET /tracks/:suid/history ───────────────────────────────────────
// Get historical CTRACK entries from timeseries — SERVER-SIDE PAGINATION
//
// Query params:
//   page       (default 1)    — 1-based page number
//   page_size  (default 20)   — rows per page (max 100)
//   trail      (default 0)    — if 1, return ONLY lat/lng for map polyline (no pagination)
//   time_from / time_to       — optional ISO date range filter
//   limit      (legacy, max for trail mode, default 5000)
//
// Optimizations:
//  1. hint('idx_ts_suid_time') — force compound index (suid+time desc)
//  2. Minimal projection — reduces BSON decode
//  3. countDocuments runs in parallel with page fetch
//  4. Trail mode returns only lat/lng (tiny payload for polyline drawing)
app.get('/tracks/:suid/history', async (req, res) => {
  try {
    const tsCol = await getTimeseriesCollection();
    const trailMode = req.query.trail === '1';
    const timeFrom = req.query.time_from ? new Date(req.query.time_from) : null;
    const timeTo   = req.query.time_to   ? new Date(req.query.time_to)   : null;

    const filter = { suid: req.params.suid };
    if (timeFrom || timeTo) {
      filter.reported_time_info = {};
      if (timeFrom) filter.reported_time_info.$gte = timeFrom;
      if (timeTo)   filter.reported_time_info.$lte = timeTo;
    }

    const startTime = Date.now();

    if (trailMode) {
      // ── Trail mode: return only coordinates for the map polyline ──
      const trailLimit = Math.min(parseInt(req.query.limit) || 5000, 10000);
      const data = await tsCol
        .find(filter, { hint: 'idx_ts_suid_time', batchSize: Math.min(trailLimit, 1000) })
        .sort({ reported_time_info: -1 })
        .limit(trailLimit)
        .project({ _id: 0, latitude: 1, longitude: 1, speed: 1, course: 1, reported_time_info: 1, ship_name: 1 })
        .toArray();
      const duration = Date.now() - startTime;

      // Convert Long→number server-side
      for (let i = 0; i < data.length; i++) {
        if (data[i].course != null) data[i].course = toLongNum(data[i].course);
      }

      logQuery({ endpoint: '/tracks/:suid/history?trail=1', collection: 'tracks_local_timeseries', operation: 'find+sort(trail)', query: filter, sort: { reported_time_info: -1 }, limit: trailLimit, projection: 'lat,lng,speed,course,time,name', duration_ms: duration, result_count: data.length, index_used: 'idx_ts_suid_time(hinted)' });
      logger.info('API', `GET /tracks/${req.params.suid}/history?trail=1 - ${data.length} in ${duration}ms`);
      return res.json({ success: true, trail: true, count: data.length, query_time_ms: duration, data });
    }

    // ── Paginated mode (default): return one page + total_count ──
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.page_size) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    // Run count + page fetch in parallel
    const [totalCount, data] = await Promise.all([
      tsCol.countDocuments(filter, { hint: 'idx_ts_suid_time' }),
      tsCol
        .find(filter, { hint: 'idx_ts_suid_time', batchSize: pageSize })
        .sort({ reported_time_info: -1 })
        .skip(skip)
        .limit(pageSize)
        .project({ _id: 0, latitude: 1, longitude: 1, speed: 1, course: 1, reported_time_info: 1, ship_name: 1 })
        .toArray(),
    ]);
    const duration = Date.now() - startTime;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    // Convert Long→number server-side
    for (let i = 0; i < data.length; i++) {
      if (data[i].course != null) data[i].course = toLongNum(data[i].course);
    }

    logQuery({ endpoint: '/tracks/:suid/history', collection: 'tracks_local_timeseries', operation: 'find+sort+skip(hinted)', query: filter, sort: { reported_time_info: -1 }, limit: pageSize, skip, projection: 'lat,lng,speed,course,time,name', duration_ms: duration, result_count: data.length, index_used: 'idx_ts_suid_time(hinted)' });
    logger.info('API', `GET /tracks/${req.params.suid}/history - page ${page}/${totalPages} (${data.length}/${totalCount}) in ${duration}ms`);
    res.json({
      success: true,
      count: data.length,
      total_count: totalCount,
      page,
      page_size: pageSize,
      total_pages: totalPages,
      query_time_ms: duration,
      data,
    });
  } catch (error) {
    logger.error('API', 'GET /tracks/:suid/history failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/performance ─────────────────────────────────────────────
// Live performance dashboard data — collection sizes, ingestion rate, db stats
let _prevTsCount = null;
let _prevTsTime  = null;

app.get('/api/performance', async (req, res) => {
  try {
    const startTime = Date.now();
    const db      = await getDb();
    const ctrackDb = await getCtrackDb();
    const ctrackCol = db.collection('ctrack_data');
    const tsCol     = ctrackDb.collection('tracks_local_timeseries');

    // Counts
    const [ctrackCount, tsCount] = await Promise.all([
      ctrackCol.estimatedDocumentCount(),
      tsCol.estimatedDocumentCount(),
    ]);

    // Collection stats
    let ctrackStats = {}, tsStats = {};
    try {
      ctrackStats = await db.command({ collStats: 'ctrack_data' });
    } catch (_) {}
    try {
      tsStats = await ctrackDb.command({ collStats: 'tracks_local_timeseries' });
    } catch (_) {}

    // Ingestion rate calculation (delta since last call)
    const now = Date.now();
    let ingestionRate = 0;
    if (_prevTsCount !== null && _prevTsTime !== null) {
      const deltaDocs = tsCount - _prevTsCount;
      const deltaSec  = (now - _prevTsTime) / 1000;
      ingestionRate = deltaSec > 0 ? Math.round(deltaDocs / deltaSec) : 0;
    }
    _prevTsCount = tsCount;
    _prevTsTime  = now;

    // Quick query benchmarks
    const benchmarks = {};
    const bench = async (name, fn) => {
      const s = Date.now();
      await fn();
      benchmarks[name] = Date.now() - s;
    };

    await bench('find_by_nationality', () =>
      ctrackCol.find({ nationality: 273 }).limit(10).toArray());
    await bench('geospatial_nearby', () =>
      ctrackCol.find({
        trackLocation: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [50, 10] },
            $maxDistance: 500000,
          },
        },
      }).limit(10).toArray());
    await bench('suid_lookup', () =>
      ctrackCol.findOne({ suid: { $exists: true } }));
    // Pick a real SUID for the timeseries benchmark
    const sampleDoc = await ctrackCol.findOne({}, { projection: { suid: 1 } });
    const sampleSuid = sampleDoc ? sampleDoc.suid : 'none';
    await bench('timeseries_history', () =>
      tsCol.find({ suid: sampleSuid }).sort({ reported_time_info: -1 }).limit(10).toArray());
    await bench('count_estimate', () =>
      ctrackCol.estimatedDocumentCount());

    const duration = Date.now() - startTime;

    res.json({
      success: true,
      query_time_ms: duration,
      timestamp: new Date().toISOString(),
      collections: {
        ctrack_data: {
          documents: ctrackCount,
          data_size_mb: parseFloat(((ctrackStats.size || 0) / 1048576).toFixed(2)),
          storage_size_mb: parseFloat(((ctrackStats.storageSize || 0) / 1048576).toFixed(2)),
          avg_doc_size_kb: parseFloat(((ctrackStats.avgObjSize || 0) / 1024).toFixed(2)),
          index_count: ctrackStats.nindexes || 0,
          index_size_mb: parseFloat(((ctrackStats.totalIndexSize || 0) / 1048576).toFixed(2)),
        },
        tracks_local_timeseries: {
          documents: tsCount,
          data_size_mb: parseFloat(((tsStats.size || 0) / 1048576).toFixed(2)),
          storage_size_mb: parseFloat(((tsStats.storageSize || 0) / 1048576).toFixed(2)),
          avg_doc_size_kb: parseFloat(((tsStats.avgObjSize || 0) / 1024).toFixed(2)),
          index_count: tsStats.nindexes || 0,
          index_size_mb: parseFloat(((tsStats.totalIndexSize || 0) / 1048576).toFixed(2)),
        },
      },
      ingestion: {
        current_rate_per_sec: ingestionRate,
        target_rate_per_sec: 4000,
        total_timeseries_docs: tsCount,
        total_ctrack_docs: ctrackCount,
      },
      benchmarks,
    });
  } catch (error) {
    logger.error('API', 'GET /api/performance failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── GET /api/query-log ─────────────────────────────────────────────
app.get('/api/query-log', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const entries = since > 0 ? queryLog.filter(e => e.id > since) : queryLog.slice(-50);
  res.json({ success: true, count: entries.length, last_id: queryLog.length > 0 ? queryLog[queryLog.length - 1].id : 0, data: entries });
});

// ─── Benchmark Runner (in-process) ─────────────────────────────────
let _benchState = null; // null | { status, config, progress, samples, report }

let _benchTsCol = null; // dedicated timeseries collection ref for benchmark

async function runBenchmarkQueries(sampleSuids) {
  const results = {};
  const t = (name, fn) => { const s = Date.now(); return fn().then(r => { results[name] = { ms: Date.now() - s, r }; }); };

  await t('map_load', () => fetch(API_BASE_INTERNAL+'/feed/geojson?limit=1000').then(r=>r.json()));
  // timeseries for 3 ships — query DB directly with dedicated connection
  const hist = [];
  logger.info('BENCH', `Timeseries benchmark: ${sampleSuids.length} suids, first=${sampleSuids[0]||'NONE'}`);
  try {
    if (!_benchTsCol) {
      const cDb = await getCtrackDb();
      _benchTsCol = cDb.collection('tracks_local_timeseries');
    }
    for (const suid of sampleSuids.slice(0,3)) {
      const s = Date.now();
      const data = await _benchTsCol.find({ suid }, { hint: 'idx_ts_suid_time', batchSize: 500 })
        .sort({ reported_time_info: -1 }).limit(500)
        .project({ _id:0, latitude:1, longitude:1, speed:1 }).toArray();
      hist.push({ ms: Date.now()-s, count: data.length });
    }
  } catch(e) {
    logger.error('BENCH', 'Timeseries benchmark error: ' + e.message + ' | stack: ' + e.stack);
    hist.push({ ms: 0, count: 0, error: e.message });
  }
  results.timeseries = hist;
  await t('geowithin', () => fetch(API_BASE_INTERNAL+'/tracks/overlay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({polygon:{type:'Polygon',coordinates:[[[40,-10],[100,-10],[100,30],[40,30],[40,-10]]]}})}).then(r=>r.json()));
  await t('nearby', () => fetch(API_BASE_INTERNAL+'/tracks/nearby?lat=10&lng=60&radius=500').then(r=>r.json()));
  await t('suid_lookup', () => fetch(API_BASE_INTERNAL+'/tracks/'+encodeURIComponent(sampleSuids[0])).then(r=>r.json()));
  await t('nationality', () => fetch(API_BASE_INTERNAL+'/tracks?limit=100&nationality=273').then(r=>r.json()));
  await t('stats', () => fetch(API_BASE_INTERNAL+'/tracks/stats').then(r=>r.json()));
  await t('performance', () => fetch(API_BASE_INTERNAL+'/api/performance').then(r=>r.json()));

  return {
    map_load: { ms: results.map_load.ms, count: results.map_load.r?.metadata?.count||0, cached: results.map_load.r?.metadata?.cached||false },
    timeseries: results.timeseries,
    geowithin: { ms: results.geowithin.ms, count: results.geowithin.r?.count||0 },
    nearby: { ms: results.nearby.ms, count: results.nearby.r?.count||0 },
    suid_lookup: { ms: results.suid_lookup.ms },
    nationality: { ms: results.nationality.ms, count: results.nationality.r?.count||0 },
    stats: { ms: results.stats.ms },
    ingestion_rate: results.performance.r?.ingestion?.current_rate_per_sec||0,
    ts_docs: results.performance.r?.ingestion?.total_timeseries_docs||0,
    ctrack_docs: results.performance.r?.ingestion?.total_ctrack_docs||0,
  };
}

const API_BASE_INTERNAL = 'http://127.0.0.1:' + (process.env.PORT || 3000);

app.post('/api/benchmark/start', async (req, res) => {
  if (_benchState && _benchState.status === 'running') {
    return res.status(409).json({ success: false, error: 'Benchmark already running' });
  }
  const opsPerSec = Math.min(Math.max(parseInt(req.body.ops_per_sec)||500, 50), 10000);
  const durationSec = Math.min(Math.max(parseInt(req.body.duration_sec)||60, 10), 600);
  const sampleInterval = Math.min(Math.max(parseInt(req.body.sample_interval)||10, 5), 60);

  _benchState = {
    status: 'running',
    config: { ops_per_sec: opsPerSec, duration_sec: durationSec, sample_interval: sampleInterval },
    started_at: new Date().toISOString(),
    progress: { phase: 'baseline', elapsed_sec: 0, total_sec: durationSec, samples_done: 0, total_samples: Math.floor(durationSec / sampleInterval) },
    samples: [],
    report: null,
  };

  res.json({ success: true, message: 'Benchmark started', config: _benchState.config });

  // Run in background
  (async () => {
    try {
      const db = await getDb();
      const ctrackDb = await getCtrackDb();
      const col = db.collection('ctrack_data');
      const suids = (await col.find({}).project({suid:1,_id:0}).limit(5).toArray()).map(s=>s.suid);
      const preCtrack = await col.estimatedDocumentCount();
      let preTs = 0;
      try { const tsStats = await ctrackDb.command({ collStats: 'tracks_local_timeseries' }); preTs = tsStats.count || 0; } catch(_) {}
      if (preTs === 0) try { preTs = await ctrackDb.collection('tracks_local_timeseries').countDocuments({}); } catch(_) {}
      logger.info('BENCH', `Resolved ${suids.length} suids, preCtrack=${preCtrack}, preTs=${preTs}`);

      // Baseline
      _benchState.progress.phase = 'baseline';
      const baselineResult = await runBenchmarkQueries(suids);
      _benchState.samples.push({ label: 'Baseline (idle)', elapsed_sec: 0, results: baselineResult });

      // Start ingestion with env overrides
      _benchState.progress.phase = 'ingestion';
      const ingEnv = { ...process.env, BENCH_OPS: String(opsPerSec), BENCH_BATCH: String(Math.min(100, opsPerSec)), BENCH_CONC: '2' };
      const ingProc = spawn('node', ['src/simulator/ingestion.js'], { stdio: 'ignore', cwd: path.join(__dirname, '../..'), env: ingEnv });

      const startTime = Date.now();
      const numSamples = Math.floor(durationSec / sampleInterval);

      for (let i = 0; i < numSamples; i++) {
        if (_benchState.status === 'cancelled') break;
        await new Promise(r => setTimeout(r, sampleInterval * 1000));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        _benchState.progress.elapsed_sec = elapsed;
        _benchState.progress.samples_done = i + 1;
        const sample = await runBenchmarkQueries(suids);
        _benchState.samples.push({ label: `Under load (${elapsed}s)`, elapsed_sec: elapsed, results: sample });
      }

      // Stop ingestion
      _benchState.progress.phase = 'stopping';
      try { ingProc.kill('SIGINT'); } catch(_){}
      await new Promise(r => setTimeout(r, 3000));
      try { ingProc.kill('SIGKILL'); } catch(_){}

      // Post-test sample
      _benchState.progress.phase = 'final';
      const finalResult = await runBenchmarkQueries(suids);
      _benchState.samples.push({ label: 'Post-ingestion (idle)', elapsed_sec: Math.round((Date.now()-startTime)/1000), results: finalResult });

      // Final counts
      const postCtrack = await col.estimatedDocumentCount();
      let postTs = 0;
      try { const tsStats2 = await ctrackDb.command({ collStats: 'tracks_local_timeseries' }); postTs = tsStats2.count || 0; } catch(_) {}
      if (postTs === 0) try { postTs = await ctrackDb.collection('tracks_local_timeseries').countDocuments({}); } catch(_) {}
      // Fallback: use last sample ts_docs
      if (postTs === 0 && _benchState.samples.length > 0) postTs = _benchState.samples[_benchState.samples.length-1].results.ts_docs || 0;
      if (preTs === 0 && _benchState.samples.length > 0) preTs = _benchState.samples[0].results.ts_docs || 0;

      // Build report
      const loadSamples = _benchState.samples.slice(1, -1);
      const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : 0;
      const mn = arr => arr.length ? Math.min(...arr) : 0;
      const mx = arr => arr.length ? Math.max(...arr) : 0;
      const p95 = arr => { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*0.95)]||0; };

      const lm = k => loadSamples.map(s => s.results[k]?.ms||0);
      const lhist = loadSamples.flatMap(s => (s.results.timeseries||[]).map(h=>h.ms));
      const rates = loadSamples.map(s => s.results.ingestion_rate||0);
      const bl = _benchState.samples[0].results;
      const fl = _benchState.samples[_benchState.samples.length-1].results;
      const allMs = [...lm('map_load'),...lhist,...lm('geowithin'),...lm('nearby'),...lm('suid_lookup'),...lm('nationality')];

      _benchState.report = {
        config: _benchState.config,
        started_at: _benchState.started_at,
        finished_at: new Date().toISOString(),
        storage: { pre_ctrack: preCtrack, post_ctrack: postCtrack, pre_ts: preTs, post_ts: postTs, new_ts_entries: postTs - preTs },
        avg_ingestion_rate: avg(rates),
        peak_ingestion_rate: mx(rates),
        queries_under_50ms_pct: allMs.length ? Math.round((allMs.filter(m=>m<50).length/allMs.length)*100) : 0,
        query_performance: [
          { name:'Map Load (1000 ships)', avg:avg(lm('map_load')), min:mn(lm('map_load')), max:mx(lm('map_load')), p95:p95(lm('map_load')), index:'idx_reported_time_desc', baseline:bl.map_load.ms, post:fl.map_load.ms },
          { name:'Timeseries History', avg:avg(lhist), min:mn(lhist), max:mx(lhist), p95:p95(lhist), index:'idx_ts_suid_time', baseline:avg((bl.timeseries||[]).map(h=>h.ms)), post:avg((fl.timeseries||[]).map(h=>h.ms)) },
          { name:'GeoWithin (polygon)', avg:avg(lm('geowithin')), min:mn(lm('geowithin')), max:mx(lm('geowithin')), p95:p95(lm('geowithin')), index:'idx_2dsphere', baseline:bl.geowithin.ms, post:fl.geowithin.ms },
          { name:'Nearby ($geoNear)', avg:avg(lm('nearby')), min:mn(lm('nearby')), max:mx(lm('nearby')), p95:p95(lm('nearby')), index:'idx_2dsphere', baseline:bl.nearby.ms, post:fl.nearby.ms },
          { name:'SUID Lookup', avg:avg(lm('suid_lookup')), min:mn(lm('suid_lookup')), max:mx(lm('suid_lookup')), p95:p95(lm('suid_lookup')), index:'idx_suid_unique', baseline:bl.suid_lookup.ms, post:fl.suid_lookup.ms },
          { name:'Nationality Filter', avg:avg(lm('nationality')), min:mn(lm('nationality')), max:mx(lm('nationality')), p95:p95(lm('nationality')), index:'idx_nationality', baseline:bl.nationality.ms, post:fl.nationality.ms },
          { name:'Stats ($facet)', avg:avg(lm('stats')), min:mn(lm('stats')), max:mx(lm('stats')), p95:p95(lm('stats')), index:'multiple', baseline:bl.stats.ms, post:fl.stats.ms },
        ],
        throughput_timeline: loadSamples.map(s => ({ elapsed_sec: s.elapsed_sec, rate: s.results.ingestion_rate, ts_docs: s.results.ts_docs })),
        samples: _benchState.samples,
      };

      _benchState.status = 'complete';
      _benchState.progress.phase = 'complete';
    } catch(err) {
      _benchState.status = 'error';
      _benchState.progress.phase = 'error';
      _benchState.report = { error: err.message };
    }
  })();
});

app.get('/api/benchmark/status', (req, res) => {
  if (!_benchState) return res.json({ success: true, status: 'idle' });
  res.json({ success: true, ..._benchState });
});

app.post('/api/benchmark/cancel', (req, res) => {
  if (_benchState && _benchState.status === 'running') _benchState.status = 'cancelled';
  res.json({ success: true });
});

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const collection = await getCollection();
    const count = await collection.estimatedDocumentCount();
    res.json({ status: 'ok', documents: count, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'error', error: error.message });
  }
});

// ─── Start server ────────────────────────────────────────────────────
async function start() {
  try {
    await connect();
    app.listen(PORT, () => {
      logger.info('API', `Server running on http://localhost:${PORT}`);
      logger.info('API', 'Endpoints:');
      logger.info('API', `  GET  /health`);
      logger.info('API', `  GET  /tracks?limit=100&nationality=419&sort=reported_time_info`);
      logger.info('API', `  GET  /tracks/overlay?polygon={GeoJSON}`);
      logger.info('API', `  GET  /tracks/stats`);
      logger.info('API', `  GET  /tracks/:suid`);
      logger.info('API', `  POST /tracks/:suid/toi`);
      logger.info('API', `  POST /tracks/:suid/remark`);
      logger.info('API', `  GET  /tracks/my-toi`);
      logger.info('API', `  GET  /tracks/my-remarks`);
      logger.info('API', `  GET  /tracks/:suid/history`);
      logger.info('API', `  POST /tracks/overlay  (JSON body)`);
      logger.info('API', `  GET  /api/performance`);
      logger.info('API', `  GET  /api/query-log?since=0`);
      logger.info('API', `  GET  /feed/geojson`);
      logger.info('API', `  GET  /ship-map-viewer.html`);
    });
  } catch (error) {
    logger.error('API', 'Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('API', 'Shutting down...');
  await disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('API', 'Shutting down...');
  await disconnect();
  process.exit(0);
});

start();

module.exports = app;
