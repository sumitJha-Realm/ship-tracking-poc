const { Long } = require('mongodb');
const { connect, getCollection, getTimeseriesCollection, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────
const TARGET_OPS_PER_SEC  = parseInt(process.env.BENCH_OPS)  || 4000;
const BATCH_SIZE          = parseInt(process.env.BENCH_BATCH) || 200;
const CONCURRENT_BATCHES  = parseInt(process.env.BENCH_CONC)  || 4;
const REPORT_INTERVAL_MS  = 5000;

// ─── Runtime state ───────────────────────────────────────────────────
let shipRegistry  = [];   // in-memory: { suid, mmsi, lat, lng, speed, course, ... }
let running       = true;
let totalOps      = 0;
let totalErrors   = 0;
let intervalOps   = 0;
let intervalErrors = 0;
let latencies     = [];

// ─── Helpers ─────────────────────────────────────────────────────────
function randomFloat(min, max) { return Math.random() * (max - min) + min; }
function randomInt(min, max)   { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, lo, hi)     { return Math.max(lo, Math.min(hi, v)); }

function formatCtrackDate(d) {
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  const yy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mi = String(d.getUTCMinutes()).padStart(2,'0');
  const ss = String(d.getUTCSeconds()).padStart(2,'0');
  const ms = String(d.getUTCMilliseconds()).padStart(3,'0');
  return `${dd}-${mm}-${yy} ${hh}:${mi}:${ss}:${ms}`;
}

// ─── Load ship registry from ctrack_data at startup ──────────────────
async function loadShipRegistry(ctrackCol) {
  logger.info('SIM', 'Loading ship registry from ctrack_data...');
  const docs = await ctrackCol.find({}, {
    projection: {
      suid: 1, mmsi_number: 1, ship_name: 1, nationality: 1,
      latitude: 1, longitude: 1, speed: 1, course: 1,
      vessel_info: 1, interface_sensor_type: 1, surv_loc_id: 1,
      source_call_sign: 1, remarks: 1,
    },
  }).toArray();

  shipRegistry = docs.map(doc => {
    const vi = (doc.vessel_info && doc.vessel_info[0]) || {};
    const toLong = v => (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : (Number(v) || 0);
    return {
      suid: doc.suid,
      mmsi: toLong(doc.mmsi_number),
      shipName: doc.ship_name || '',
      nat: toLong(doc.nationality),
      lat: typeof doc.latitude === 'number' ? doc.latitude : 0,
      lng: typeof doc.longitude === 'number' ? doc.longitude : 0,
      speed: typeof doc.speed === 'number' ? doc.speed : randomFloat(0, 20),
      course: toLong(doc.course),
      shipType: toLong(vi.ship_type),
      vesselLength: toLong(vi.total_vessel_length),
      vesselWidth: toLong(vi.total_vessel_width),
      lengthBow: toLong(vi.length_bow),
      lengthStern: toLong(vi.length_stream),
      imoNo: toLong(vi.imo_no),
      draught: typeof vi.draught === 'number' ? vi.draught : 8,
      cargoType: toLong(vi.cargo_type),
      survLocId: toLong(doc.surv_loc_id),
      sensorType: toLong(doc.interface_sensor_type),
      callSign: doc.source_call_sign || '',
      remarks: doc.remarks || '',
    };
  });

  logger.info('SIM', `Loaded ${shipRegistry.length.toLocaleString()} ships into memory`);
}

// ─── Build a full CTRACK document from ship state ────────────────────
function buildCtrackDoc(ship, now) {
  const timeStr    = formatCtrackDate(now);
  const createdStr = timeStr + String(randomInt(10, 99));

  return {
    reported_time_info: now,
    suid: ship.suid,
    speed: parseFloat(ship.speed.toFixed(6)),
    identity: Long.fromNumber(0),
    length_global_data: Long.fromNumber(340),
    height_depth: Long.fromNumber(0),
    threat_score: Long.fromNumber(randomInt(0, 100)),
    cov_x_vx: Long.fromNumber(0),
    cov_y_vy: Long.fromNumber(0),
    cov_vy_vy: Long.fromNumber(0),
    track_prefix_flag: Long.fromNumber(0),
    system_updated_time_info: timeStr,
    css_track_status: Long.fromNumber(1),
    threat_score_updated_flag: Long.fromNumber(0),
    surv_oc_id: [Long.fromNumber(0), Long.fromNumber(ship.survLocId)],
    vessel_info: [{
      total_vessel_width: Long.fromNumber(ship.vesselWidth),
      length_bow: Long.fromNumber(ship.lengthBow),
      destination: '',
      length_stream: Long.fromNumber(ship.lengthStern),
      cargo_type: Long.fromNumber(ship.cargoType),
      width_starboard: Long.fromNumber(Math.floor(ship.vesselWidth / 2)),
      rate_of_turn: Long.fromNumber(randomInt(-5, 5)),
      ship_type: Long.fromNumber(ship.shipType),
      class_a_b_info_validity: Long.fromNumber(0),
      eta: '00-00-0000 00:00:00:000',
      draught: ship.draught,
      imo_no: Long.fromNumber(ship.imoNo),
      total_vessel_length: Long.fromNumber(ship.vesselLength),
      type_of_position_fixing_devices: Long.fromNumber(1),
      ais_id_version: Long.fromNumber(0),
      navigational_status: Long.fromNumber(randomInt(0, 15)),
      width_port: Long.fromNumber(Math.ceil(ship.vesselWidth / 2)),
    }],
    pans_info: [],
    source_call_sign: ship.callSign,
    sticky_flag: Long.fromNumber(0),
    latitude: ship.lat,
    ship_name: ship.shipName,
    station_contriburtion: [],
    no_contrib: Long.fromNumber(1),
    cov_vx_vy: Long.fromNumber(0),
    interface_id: Long.fromNumber(1),
    vigilance_score: Long.fromNumber(randomInt(0, 100)),
    cov_y_vx: Long.fromNumber(0),
    cov_y_y: Long.fromNumber(0),
    css_track_quality: Long.fromNumber(randomInt(50, 100)),
    classification_info_css_trk_class: Long.fromNumber(ship.shipType),
    created_time_info: createdStr,
    interface_surv_loc_id: Long.fromNumber(ship.survLocId),
    user_call_sign: '',
    cov_x_y: Long.fromNumber(0),
    nationality: Long.fromNumber(ship.nat),
    spares_gflags: Long.fromNumber(0),
    remarks: ship.remarks,
    surv_loc_id: Long.fromNumber(ship.survLocId),
    cov_vx_vx: Long.fromNumber(0),
    timestamp: now,
    no_of_surv: Long.fromNumber(1),
    track_prefix: '',
    contriburtion: [{
      interface_id: Long.fromNumber(1),
      surv_loc_id: Long.fromNumber(ship.survLocId),
      pos: {
        altitude: Long.fromNumber(0),
        latitude: ship.lat,
        longitude: ship.lng,
      },
      src_track_no: Long.fromNumber(ship.mmsi),
      track_number: Long.fromNumber(0),
      sensor_type: Long.fromNumber(ship.sensorType),
      contrib_time: timeStr,
    }],
    interface_sensor_type: Long.fromNumber(ship.sensorType),
    course: Long.fromNumber(ship.course),
    trackAltitude: Long.fromNumber(0),
    no_station_contrib: Long.fromNumber(0),
    longitude: ship.lng,
    classification_info_track_type: Long.fromNumber(1),
    mmsi_number: Long.fromNumber(ship.mmsi),
    classification_info_css_category: Long.fromNumber(1),
    cov_x_vy: Long.fromNumber(0),
    toi_flag: Long.fromNumber(0),
    nsc_validity_flag: Long.fromNumber(0),
    classification_info_css_sub_class: Long.fromNumber(1),
    track_processed_flag: Long.fromNumber(0),
    cov_x_x: Long.fromNumber(0),
  };
}

// ─── Execute one batch: pick ships, move, dual-write ─────────────────
async function executeBatch(ctrackCol, tsCol) {
  if (shipRegistry.length === 0) return;

  const now      = new Date();
  const ctrackOps = [];
  const tsDocs    = [];

  for (let i = 0; i < BATCH_SIZE; i++) {
    // Pick a random ship
    const ship = shipRegistry[randomInt(0, shipRegistry.length - 1)];

    // Move the ship slightly
    ship.lat   = clamp(ship.lat + randomFloat(-0.01, 0.01), -85, 85);
    ship.lng   = clamp(ship.lng + randomFloat(-0.01, 0.01), -180, 180);
    ship.speed = clamp(ship.speed + randomFloat(-1.5, 1.5), 0, 30);
    ship.course = clamp(ship.course + randomInt(-10, 10), 0, 359);

    const doc = buildCtrackDoc(ship, now);

    // ① ctrack_data: upsert latest by suid (replaceOne)
    const ctrackDoc = { ...doc, trackLocation: { type: 'Point', coordinates: [ship.lng, ship.lat] } };
    ctrackOps.push({
      replaceOne: {
        filter: { suid: ship.suid },
        replacement: ctrackDoc,
        upsert: true,
      },
    });

    // ② timeseries: insert raw CTRACK (no trackLocation)
    tsDocs.push(doc);
  }

  const start = Date.now();
  try {
    await Promise.all([
      ctrackCol.bulkWrite(ctrackOps, { ordered: false }),
      tsCol.insertMany(tsDocs, { ordered: false }),
    ]);
    const latency = Date.now() - start;
    totalOps    += BATCH_SIZE;
    intervalOps += BATCH_SIZE;
    latencies.push(latency);
  } catch (error) {
    totalErrors++;
    intervalErrors++;
    logger.error('SIM', `Batch error: ${error.message}`);
  }
}

// ─── Continuous ingestion loop ───────────────────────────────────────
async function ingestionLoop(ctrackCol, tsCol) {
  const batchesPerSec = TARGET_OPS_PER_SEC / BATCH_SIZE;
  const delay = Math.max(1, Math.floor(1000 / batchesPerSec / CONCURRENT_BATCHES));

  logger.info('SIM', `Target: ${TARGET_OPS_PER_SEC} ops/sec  |  Batch: ${BATCH_SIZE}  |  Concurrent: ${CONCURRENT_BATCHES}`);
  logger.info('SIM', `Delay between rounds: ~${delay}ms`);
  logger.info('SIM', `Dual-write: ship_tracking.ctrack_data (upsert) + CTRACK.tracks_local_timeseries (insert)`);
  logger.info('SIM', '');

  while (running) {
    const promises = [];
    for (let i = 0; i < CONCURRENT_BATCHES; i++) {
      promises.push(executeBatch(ctrackCol, tsCol));
    }
    await Promise.all(promises);
    await new Promise(r => setTimeout(r, delay));
  }
}

// ─── Metrics reporter ────────────────────────────────────────────────
function startReporting() {
  const startTime = Date.now();

  return setInterval(() => {
    if (!running) return;

    const elapsed     = ((Date.now() - startTime) / 1000).toFixed(0);
    const currentRate = Math.round(intervalOps / (REPORT_INTERVAL_MS / 1000));
    const overallRate = Math.round(totalOps / ((Date.now() - startTime) / 1000));

    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]  || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    const avg = sorted.length > 0 ? Math.round(sorted.reduce((a,b) => a+b, 0) / sorted.length) : 0;

    console.log('');
    console.log(`===== Ingestion Report (${elapsed}s) =====`);
    console.log(`  Current rate:  ${currentRate.toLocaleString()} ops/sec  (target ${TARGET_OPS_PER_SEC})`);
    console.log(`  Overall rate:  ${overallRate.toLocaleString()} ops/sec`);
    console.log(`  Total ops:     ${totalOps.toLocaleString()}`);
    console.log(`  Total errors:  ${totalErrors.toLocaleString()}`);
    console.log(`  Batch latency: avg=${avg}ms  P50=${p50}ms  P95=${p95}ms  P99=${p99}ms`);
    console.log(`  Dual-write:    ctrack_data (replace) + timeseries (insert)`);
    console.log('==========================================');

    intervalOps = 0;
    intervalErrors = 0;
    latencies = [];
  }, REPORT_INTERVAL_MS);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  try {
    await connect();
    const ctrackCol = await getCollection();
    const tsCol     = await getTimeseriesCollection();

    // Verify ctrack_data has ships
    const count = await ctrackCol.estimatedDocumentCount();
    if (count === 0) {
      logger.error('SIM', 'No documents in ctrack_data. Run "npm run seed-data" first.');
      await disconnect();
      process.exit(1);
    }

    // Load ship registry into memory
    await loadShipRegistry(ctrackCol);

    logger.info('SIM', `Starting dual-write ingestion against ${count.toLocaleString()} ships`);
    logger.info('SIM', 'Press Ctrl+C to stop\n');

    startReporting();
    await ingestionLoop(ctrackCol, tsCol);
  } catch (error) {
    logger.error('SIM', 'Simulator failed:', error.message);
    console.error(error);
  } finally {
    running = false;
    await disconnect();
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n');
  logger.info('SIM', 'Stopping ingestion...');
  running = false;
  logger.info('SIM', `Final: ${totalOps.toLocaleString()} ops  |  ${totalErrors.toLocaleString()} errors`);
  setTimeout(async () => { await disconnect(); process.exit(0); }, 1000);
});

main();
