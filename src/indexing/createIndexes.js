const { connect, getCollection, getTimeseriesCollection, ensureTimeseriesCollection, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

// ─── ctrack_data indexes (ship_tracking db) ──────────────────────────
const CTRACK_INDEXES = [
  {
    key: { suid: 1 },
    options: { name: 'idx_suid' },
    purpose: 'Ship lookup by suid',
  },
  {
    key: { trackLocation: '2dsphere' },
    options: { name: 'idx_trackLocation_2dsphere' },
    purpose: 'Geospatial queries (overlay/geo-fence)',
  },
  {
    key: { nationality: 1 },
    options: { name: 'idx_nationality' },
    purpose: 'Filter by nationality',
  },
  {
    key: { 'vessel_info.ship_type': 1 },
    options: { name: 'idx_vessel_ship_type' },
    purpose: 'Filter by ship type (nested in vessel_info)',
  },
  {
    key: { reported_time_info: -1 },
    options: { name: 'idx_reported_time_desc' },
    purpose: 'Time sorting (default sort)',
  },
  {
    key: { mmsi_number: 1 },
    options: { name: 'idx_mmsi' },
    purpose: 'MMSI number lookup',
  },
  {
    key: { nationality: 1, reported_time_info: -1 },
    options: { name: 'idx_nat_time' },
    purpose: 'Compound filter + sort',
  },
  {
    key: { threat_score: 1 },
    options: { name: 'idx_threat_score' },
    purpose: 'Threat score filtering/stats',
  },
];

// ─── timeseries secondary indexes (CTRACK db) ───────────────────────
const TS_INDEXES = [
  {
    key: { 'suid': 1, 'reported_time_info': -1 },
    options: { name: 'idx_ts_suid_time' },
    purpose: 'Ship history lookup by suid + time',
  },
  {
    key: { mmsi_number: 1, reported_time_info: -1 },
    options: { name: 'idx_ts_mmsi_time' },
    purpose: 'Ship history by MMSI',
  },
  {
    key: { trackLocation: '2dsphere' },
    options: { name: 'idx_ts_trackLocation_2dsphere' },
    purpose: 'Geospatial queries on historical positions',
  },
];

async function createIndexesForCollection(collection, indexes, label) {
  logger.info('INDEX', `Creating ${indexes.length} indexes on ${label}...`);
  for (const index of indexes) {
    try {
      const result = await collection.createIndex(index.key, index.options);
      logger.info('INDEX', `  ${result} — ${index.purpose}`);
    } catch (error) {
      if (error.code === 85 || error.code === 86) {
        logger.warn('INDEX', `  Already exists: ${index.options.name}`);
      } else {
        throw error;
      }
    }
  }
  const all = await collection.listIndexes().toArray();
  logger.info('INDEX', `  Total indexes on ${label}: ${all.length}`);
  all.forEach(idx => logger.info('INDEX', `    - ${idx.name}: ${JSON.stringify(idx.key)}`));
}

async function createIndexes() {
  try {
    await connect();

    // 1. Ensure timeseries collection exists
    await ensureTimeseriesCollection();

    // 2. ctrack_data indexes
    const ctrackCol = await getCollection();
    await createIndexesForCollection(ctrackCol, CTRACK_INDEXES, 'ship_tracking.ctrack_data');

    // 3. timeseries indexes
    const tsCol = await getTimeseriesCollection();
    await createIndexesForCollection(tsCol, TS_INDEXES, 'CTRACK.tracks_local_timeseries');

    logger.info('INDEX', 'All index creation complete');
  } catch (error) {
    logger.error('INDEX', 'Index creation failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await disconnect();
  }
}

createIndexes();
