const { connect, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

const SUMMARY_COLLECTION = 'track_counts_hourly';
const TS_COLLECTION = 'tracks_local_timeseries';
const HOUR_FORMAT = '%Y-%m-%dT%H'; // e.g. "2026-05-11T14"

// ─── Backfill: aggregate ALL existing data into hourly buckets ───────
async function backfill() {
  const { db } = await connect();
  const summaryCol = db.collection(SUMMARY_COLLECTION);

  logger.info('COUNTS', 'Backfilling hourly counts from timeseries...');
  const start = Date.now();

  await db.collection(TS_COLLECTION).aggregate([
    { $group: {
      _id: { $dateToString: { format: HOUR_FORMAT, date: '$reported_time_info' } },
      count: { $sum: 1 }
    }},
    { $merge: { into: SUMMARY_COLLECTION, whenMatched: 'replace', whenNotMatched: 'insert' } }
  ], { allowDiskUse: true }).toArray();

  const total = await summaryCol.countDocuments();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info('COUNTS', `Backfill done: ${total} hourly buckets in ${elapsed}s`);

  const sample = await summaryCol.find().sort({ _id: -1 }).limit(5).toArray();
  console.log('\nRecent hourly counts:');
  sample.forEach(d => console.log(`  ${d._id}:00 → ${d.count.toLocaleString()} docs`));
  console.log('');
}

// ─── Refresh: re-aggregate last 2 hours only (fast) ──────────────────
async function refreshLastHours() {
  const { db } = await connect();
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // last 2 hours
  const start = Date.now();

  await db.collection(TS_COLLECTION).aggregate([
    { $match: { reported_time_info: { $gte: since } } },
    { $group: {
      _id: { $dateToString: { format: HOUR_FORMAT, date: '$reported_time_info' } },
      count: { $sum: 1 }
    }},
    { $merge: { into: SUMMARY_COLLECTION, whenMatched: 'replace', whenNotMatched: 'insert' } }
  ]).toArray();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info('COUNTS', `Refreshed last 2 hours in ${elapsed}s`);
}

// ─── Scheduler: backfill once, then refresh every hour ───────────────
async function startScheduler() {
  await backfill();
  logger.info('COUNTS', 'Scheduling hourly refresh...');

  setInterval(async () => {
    try {
      await refreshLastHours();
    } catch (err) {
      logger.error('COUNTS', `Refresh error: ${err.message}`);
    }
  }, 60 * 60 * 1000);
}

// ─── Check: how many docs inserted in the last 1 hour ────────────────
async function checkLastHour() {
  const { db } = await connect();
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);

  // Current hour key
  const currentHourKey = now.toISOString().slice(0, 13);  // "2026-05-11T14"
  const prevHourKey = oneHourAgo.toISOString().slice(0, 13);

  const start = Date.now();

  // Also do a live count from timeseries for accuracy
  const liveCount = await db.collection(TS_COLLECTION).countDocuments({
    reported_time_info: { $gte: oneHourAgo, $lte: now }
  });

  // Pre-computed (may be slightly stale)
  const buckets = await db.collection(SUMMARY_COLLECTION)
    .find({ _id: { $in: [prevHourKey, currentHourKey] } }).toArray();

  const precomputed = buckets.reduce((sum, b) => sum + b.count, 0);
  const elapsed = Date.now() - start;

  console.log(`\n── Docs inserted in last 1 hour ──`);
  console.log(`  Time range : ${oneHourAgo.toISOString()} → ${now.toISOString()}`);
  console.log(`  Live count : ${liveCount.toLocaleString()}`);
  console.log(`  Pre-computed: ${precomputed.toLocaleString()} (buckets: ${buckets.map(b => b._id).join(', ') || 'none'})`);
  console.log(`  Query time : ${elapsed} ms\n`);
}

// ─── Query: sum hourly buckets for last N days ───────────────────────
async function getCount(days) {
  const { db } = await connect();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffKey = cutoff.toISOString().slice(0, 13); // "2026-03-11T14"

  const start = Date.now();
  const result = await db.collection(SUMMARY_COLLECTION).aggregate([
    { $match: { _id: { $gte: cutoffKey } } },
    { $group: { _id: null, total: { $sum: '$count' }, hours: { $sum: 1 } } }
  ]).toArray();

  const elapsed = Date.now() - start;
  const total = result[0]?.total || 0;
  const hours = result[0]?.hours || 0;

  console.log(`\n── Count for last ${days} days (since ${cutoffKey}:00) ──`);
  console.log(`  Total docs  : ${total.toLocaleString()}`);
  console.log(`  Hour buckets: ${hours}`);
  console.log(`  Avg/hour    : ${hours ? Math.round(total / hours).toLocaleString() : 0}`);
  console.log(`  Query time  : ${elapsed} ms\n`);

  return total;
}

// ─── CLI ─────────────────────────────────────────────────────────────
const cmd = process.argv[2];

if (cmd === 'backfill') {
  backfill().then(() => disconnect());
} else if (cmd === 'scheduler') {
  startScheduler(); // runs forever, refreshes every hour
} else if (cmd === 'check') {
  checkLastHour().then(() => disconnect());
} else if (cmd === 'query') {
  const days = parseInt(process.argv[3]) || 180;
  getCount(days).then(() => disconnect());
} else {
  console.log('Usage:');
  console.log('  node src/monitoring/trackCounts.js backfill      # One-time backfill (all data → hourly buckets)');
  console.log('  node src/monitoring/trackCounts.js scheduler     # Backfill + auto-refresh every hour');
  console.log('  node src/monitoring/trackCounts.js check         # Docs inserted in last 1 hour');
  console.log('  node src/monitoring/trackCounts.js query 180     # Total count for last N days');
  process.exit(0);
}
