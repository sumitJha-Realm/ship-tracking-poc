const { connect, getCollection, getDb, getCtrackDb, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

const MONITOR_INTERVAL_MS = 10000; // Report every 10 seconds
let running = true;
let previousCount = 0;
let previousTime = Date.now();

async function getCollectionStats(db, collectionName) {
  try {
    const stats = await db.command({ collStats: collectionName });
    return {
      documents: stats.count,
      dataSize: formatBytes(stats.size),
      storageSize: formatBytes(stats.storageSize),
      avgDocSize: formatBytes(stats.avgObjSize || 0),
      indexes: stats.nindexes,
      indexSize: formatBytes(stats.totalIndexSize),
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function getIndexDetails(collection) {
  try {
    const indexes = await collection.listIndexes().toArray();
    return indexes.map((idx) => ({
      name: idx.name,
      key: JSON.stringify(idx.key),
      unique: idx.unique || false,
    }));
  } catch (error) {
    return [];
  }
}

async function runQueryBenchmark(collection) {
  const benchmarks = {};

  // 1. Simple find by nationality
  let start = Date.now();
  await collection.find({ nationality: 419 }).limit(100).toArray();
  benchmarks['find_by_nationality'] = Date.now() - start;

  // 2. Aggregation with color logic
  start = Date.now();
  await collection
    .aggregate([
      { $match: { nationality: 273 } },
      { $limit: 100 },
      {
        $addFields: {
          color: {
            $switch: {
              branches: [
                { case: { $eq: ['$nationality', 419] }, then: '#e4e901' },
                { case: { $eq: ['$nationality', 273] }, then: '#FF0000' },
              ],
              default: '#FFFFFF',
            },
          },
        },
      },
    ])
    .toArray();
  benchmarks['aggregation_with_color'] = Date.now() - start;

  // 3. Geospatial query
  start = Date.now();
  await collection
    .aggregate([
      {
        $match: {
          trackLocation: {
            $geoWithin: {
              $geometry: {
                type: 'Polygon',
                coordinates: [[[0, 0], [0, 45], [45, 45], [45, 0], [0, 0]]],
              },
            },
          },
        },
      },
      { $limit: 100 },
    ])
    .toArray();
  benchmarks['geospatial_query'] = Date.now() - start;

  // 4. Count documents
  start = Date.now();
  await collection.estimatedDocumentCount();
  benchmarks['estimated_count'] = Date.now() - start;

  // 5. Stats aggregation
  start = Date.now();
  await collection
    .aggregate([
      {
        $group: {
          _id: '$nationality',
          count: { $sum: 1 },
          avgSpeed: { $avg: { $toDouble: '$speed' } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ])
    .toArray();
  benchmarks['stats_aggregation'] = Date.now() - start;

  return benchmarks;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function runMonitorCycle(collection, db, ctrackDb) {
  const now = Date.now();

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║               SHIP TRACKING - PERFORMANCE MONITOR           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Time: ${new Date().toISOString()}                    ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ship_tracking.ctrack_data stats
  const stats = await getCollectionStats(db, 'ctrack_data');
  if (stats.error) {
    console.log(`\n  [Collection Stats] Error: ${stats.error}`);
  } else {
    console.log('\n  --- Collection Stats ---');
    console.log(`  Documents:      ${stats.documents?.toLocaleString()}`);
    console.log(`  Data Size:      ${stats.dataSize}`);
    console.log(`  Storage Size:   ${stats.storageSize}`);
    console.log(`  Avg Doc Size:   ${stats.avgDocSize}`);
    console.log(`  Indexes:        ${stats.indexes}`);
    console.log(`  Index Size:     ${stats.indexSize}`);

    // Calculate ingestion rate
    const elapsed = (now - previousTime) / 1000;
    const docDiff = (stats.documents || 0) - previousCount;
    const rate = elapsed > 0 ? Math.round(docDiff / elapsed) : 0;
    if (previousCount > 0 && rate !== 0) {
      console.log(`  Doc Change Rate: ${rate >= 0 ? '+' : ''}${rate}/sec`);
    }
    previousCount = stats.documents || 0;
    previousTime = now;
  }

  // CTRACK.tracks_local_timeseries stats
  const tsStats = await getCollectionStats(ctrackDb, 'tracks_local_timeseries');
  if (tsStats.error) {
    console.log(`\n  [Timeseries Stats] Error: ${tsStats.error}`);
  } else {
    console.log('\n  --- CTRACK.tracks_local_timeseries ---');
    console.log(`  Documents:      ${tsStats.documents?.toLocaleString()}`);
    console.log(`  Data Size:      ${tsStats.dataSize}`);
    console.log(`  Storage Size:   ${tsStats.storageSize}`);
    console.log(`  Avg Doc Size:   ${tsStats.avgDocSize}`);
  }

  // Index details
  const indexes = await getIndexDetails(collection);
  console.log('\n  --- Indexes ---');
  indexes.forEach((idx) => {
    console.log(`  ${idx.name}: ${idx.key}${idx.unique ? ' (unique)' : ''}`);
  });

  // Query benchmarks
  console.log('\n  --- Query Benchmarks ---');
  const benchmarks = await runQueryBenchmark(collection);
  for (const [name, ms] of Object.entries(benchmarks)) {
    const indicator = ms < 10 ? '🟢' : ms < 50 ? '🟡' : '🔴';
    console.log(`  ${indicator} ${name}: ${ms}ms`);
  }

  // Recommendations
  console.log('\n  --- Recommendations ---');
  const totalBenchTime = Object.values(benchmarks).reduce((a, b) => a + b, 0);
  if (totalBenchTime < 100) {
    console.log('  All queries performing well.');
  } else {
    if (benchmarks.geospatial_query > 50) {
      console.log('  - Consider checking 2dsphere index on trackLocation');
    }
    if (benchmarks.find_by_nationality > 20) {
      console.log('  - Consider compound index on frequently filtered fields');
    }
    if (benchmarks.stats_aggregation > 100) {
      console.log('  - Stats aggregation slow; consider materialized views');
    }
  }

  console.log('\n  ─────────────────────────────────────────────────────────');
}

async function main() {
  try {
    await connect();
    const collection = await getCollection();
    const db = await getDb();
    const ctrackDb = await getCtrackDb();

    const count = await collection.estimatedDocumentCount();
    if (count === 0) {
      logger.warn('MONITOR', 'No documents found. Run "npm run seed-data" first.');
    }

    logger.info('MONITOR', `Starting performance monitor (every ${MONITOR_INTERVAL_MS / 1000}s)`);
    logger.info('MONITOR', 'Press Ctrl+C to stop');

    previousCount = count;
    previousTime = Date.now();

    // Run first cycle immediately
    await runMonitorCycle(collection, db, ctrackDb);

    // Then run on interval
    const interval = setInterval(async () => {
      if (!running) {
        clearInterval(interval);
        return;
      }
      try {
        await runMonitorCycle(collection, db, ctrackDb);
      } catch (error) {
        logger.error('MONITOR', 'Monitor cycle error:', error.message);
      }
    }, MONITOR_INTERVAL_MS);
  } catch (error) {
    logger.error('MONITOR', 'Monitor failed:', error.message);
    await disconnect();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\n');
  logger.info('MONITOR', 'Stopping monitor...');
  running = false;
  setTimeout(async () => {
    await disconnect();
    process.exit(0);
  }, 1000);
});

main();
