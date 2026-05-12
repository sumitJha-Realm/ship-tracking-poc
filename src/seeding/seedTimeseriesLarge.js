const { Long } = require('mongodb');
const { connect, getCollection, getTimeseriesCollection, ensureTimeseriesCollection, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────
const SHIPS_TO_PICK = 50;              // Pick 50 unique ships from ctrack_data
const DOCS_PER_SHIP = 2000;            // 2000 history records per ship
const TOTAL_DOCS = SHIPS_TO_PICK * DOCS_PER_SHIP; // 100,000 total
const BATCH_SIZE = 5_000;              // Insert 5k docs per batch
const DAYS_BACK = 30;                  // Spread over last 1 month

// ─── These are only used for doc generation, not ship registry ───────
const NATIONALITIES = [
  273, 419, 501, 502, 503, 504, 505, 506, 508, 510,
  511, 512, 514, 515, 516, 518, 519, 520, 538,
];

// ─── Ship name word pools (kept for reference only) ──────────────────
const FIRST_WORDS = [
  'Northern','Southern','Eastern','Western','Pacific','Atlantic','Arctic','Indian','Blue','Golden',
  'Silver','Crystal','Royal','Imperial','Grand','Noble','Brave','Swift','Mighty','Iron',
  'Coral','Emerald','Crimson','Sapphire','Diamond','Pearl','Jade','Amber','Scarlet','Azure',
  'Ocean','Sea','Star','Sun','Storm','Wind','Wave','Reef','Cape','Harbor',
  'Bay','Gulf','Crest','Tide','Coast','Deep','Bright','Dawn','Dusk','Horizon',
];
const SECOND_WORDS = [
  'Voyager','Explorer','Pioneer','Venture','Spirit','Dream','Glory','Pride','Fortune','Grace',
  'Maiden','Queen','King','Prince','Guardian','Sentinel','Ranger','Navigator','Mariner','Trader',
  'Carrier','Runner','Hawk','Eagle','Falcon','Phoenix','Dragon','Titan','Atlas','Neptune',
  'Poseidon','Triton','Mercury','Apollo','Orion','Pegasus','Liberty','Victory','Harmony','Serenity',
  'Destiny','Endeavour','Discovery','Challenger','Enterprise','Odyssey','Legend','Sovereign','Majestic','Resolute',
];

const SHIP_TYPES   = [30,31,32,33,34,35,36,37,40,50,51,52,60,70,71,72,80];
const SENSOR_TYPES = [1,2,3,4,5];
const SURV_LOC_IDS = [50000,51000,52000,53000,54000,55000];
const CARGO_TYPES  = [0,1,2,3,4,5];
const REMARKS_POOL = ['T3  WRSIN','T1  RADAR','T2  AIS','T4  LRIT','T5  VMS','T3  COASTAL','T1  SATCOM','T2  VTS','','','',''];
const DESTINATIONS = [
  'SINGAPORE','SHANGHAI','ROTTERDAM','DUBAI','MUMBAI','HONG KONG','BUSAN','TOKYO',
  'HAMBURG','ANTWERP','LOS ANGELES','NEW YORK','PIRAEUS','COLOMBO','JEDDAH',
  'PORT SAID','VALENCIA','FELIXSTOWE','TANJUNG PELEPAS','KAOHSIUNG','','','',
];

// ─── Maritime zones for realistic ship placement ─────────────────────
const ZONES = [
  { latMin: -10, latMax: 25, lngMin: 40,  lngMax: 100 },  // Indian Ocean
  { latMin: 30,  latMax: 45, lngMin: -5,  lngMax: 35  },  // Mediterranean
  { latMin: 5,   latMax: 25, lngMin: 55,  lngMax: 75  },  // Arabian Sea
  { latMin: -5,  latMax: 25, lngMin: 100, lngMax: 125 },  // South China Sea
  { latMin: 10,  latMax: 50, lngMin: 130, lngMax: 175 },  // North Pacific
  { latMin: -40, latMax: -5, lngMin: 150, lngMax: 180 },  // South Pacific
  { latMin: 25,  latMax: 60, lngMin: -60, lngMax: 0   },  // North Atlantic
  { latMin: -40, latMax: 0,  lngMin: -40, lngMax: 15  },  // South Atlantic
  { latMin: 10,  latMax: 25, lngMin: -90, lngMax: -60 },  // Caribbean
  { latMin: 5,   latMax: 22, lngMin: 78,  lngMax: 95  },  // Bay of Bengal
];

// ─── Helpers ─────────────────────────────────────────────────────────
function randomFloat(min, max) { return Math.random() * (max - min) + min; }
function randomInt(min, max)   { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomItem(arr)       { return arr[Math.floor(Math.random() * arr.length)]; }

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

function formatSuid(mmsi, d) {
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  const yy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mi = String(d.getUTCMinutes()).padStart(2,'0');
  const ss = String(d.getUTCSeconds()).padStart(2,'0');
  const ms = String(d.getUTCMilliseconds()).padStart(3,'0');
  return `${mmsi}_${dd}-${mm}-${yy}_${hh}:${mi}:${ss}:${ms}`;
}

// ─── Load ships from ctrack_data (uses EXACT same suids as the map) ──
async function loadShipsFromCtrack() {
  const ctrackCol = await getCollection();
  logger.info('SEED-TS', `Loading ${SHIPS_TO_PICK} ships from ctrack_data...`);

  const docs = await ctrackCol.find({})
    .sort({ reported_time_info: -1 })
    .limit(SHIPS_TO_PICK)
    .project({
      _id: 0, suid: 1, ship_name: 1, latitude: 1, longitude: 1,
      speed: 1, course: 1, nationality: 1, mmsi_number: 1,
      interface_sensor_type: 1, surv_loc_id: 1, source_call_sign: 1,
      'vessel_info.ship_type': 1, 'vessel_info.total_vessel_length': 1,
      'vessel_info.total_vessel_width': 1, 'vessel_info.length_bow': 1,
      'vessel_info.length_stream': 1, 'vessel_info.cargo_type': 1,
      'vessel_info.imo_no': 1, 'vessel_info.draught': 1,
    })
    .toArray();

  if (docs.length === 0) {
    throw new Error('No ships found in ctrack_data. Run "npm run seed-data" first.');
  }

  const toLong = v => (v && typeof v === 'object' && typeof v.toNumber === 'function') ? v.toNumber() : v;

  const ships = docs.map((doc, i) => {
    const vi = doc.vessel_info?.[0] || {};
    return {
      idx: i,
      suid: doc.suid,
      shipName: doc.ship_name,
      lat: doc.latitude,
      lng: doc.longitude,
      speed: doc.speed || 0,
      course: toLong(doc.course) || 0,
      nat: toLong(doc.nationality) || 273,
      mmsi: toLong(doc.mmsi_number) || 0,
      sensorType: toLong(doc.interface_sensor_type) || 1,
      survLocId: toLong(doc.surv_loc_id) || 50000,
      callSign: doc.source_call_sign || '',
      shipType: toLong(vi.ship_type) || 30,
      vesselLength: toLong(vi.total_vessel_length) || 100,
      vesselWidth: toLong(vi.total_vessel_width) || 15,
      lengthBow: toLong(vi.length_bow) || 15,
      lengthStern: toLong(vi.length_stream) || 85,
      cargoType: toLong(vi.cargo_type) || 0,
      imoNo: toLong(vi.imo_no) || 1000000,
      draught: vi.draught || 5.0,
    };
  });

  logger.info('SEED-TS', `Loaded ${ships.length} ships from ctrack_data`);
  return ships;
}

// ─── Generate a timeseries document ──────────────────────────────────
function generateTimeseriesDoc(ship, timestamp) {
  const createdStr  = formatCtrackDate(timestamp) + String(randomInt(10, 99));
  const timeStr     = formatCtrackDate(timestamp);

  return {
    reported_time_info: timestamp,
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
      destination: randomItem(DESTINATIONS),
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
    latitude: ship.lat + randomFloat(-0.01, 0.01),  // Slightly vary position
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
    remarks: randomItem(REMARKS_POOL),
    surv_loc_id: Long.fromNumber(ship.survLocId),
    cov_vx_vx: Long.fromNumber(0),
    timestamp: timestamp,
    no_of_surv: Long.fromNumber(1),
    track_prefix: '',
    contriburtion: [{
      interface_id: Long.fromNumber(1),
      surv_loc_id: Long.fromNumber(ship.survLocId),
      pos: {
        altitude: Long.fromNumber(0),
        latitude: ship.lat + randomFloat(-0.01, 0.01),
        longitude: ship.lng + randomFloat(-0.01, 0.01),
      },
      src_track_no: Long.fromNumber(ship.mmsi),
      track_number: Long.fromNumber(0),
      sensor_type: Long.fromNumber(ship.sensorType),
      contrib_time: timeStr,
    }],
    interface_sensor_type: Long.fromNumber(ship.sensorType),
    course: Long.fromNumber(ship.course + randomInt(-5, 5)),
    trackAltitude: Long.fromNumber(0),
    no_station_contrib: Long.fromNumber(0),
    longitude: ship.lng + randomFloat(-0.01, 0.01),
    classification_info_track_type: Long.fromNumber(1),
    mmsi_number: Long.fromNumber(ship.mmsi),
    classification_info_css_category: Long.fromNumber(1),
    cov_x_vy: Long.fromNumber(0),
    toi_flag: Long.fromNumber(0),
    nsc_validity_flag: Long.fromNumber(0),
    classification_info_css_sub_class: Long.fromNumber(1),
    track_processed_flag: Long.fromNumber(0),
    cov_x_x: Long.fromNumber(0),
    trackLocation: { type: 'Point', coordinates: [ship.lng + randomFloat(-0.01, 0.01), ship.lat + randomFloat(-0.01, 0.01)] },
  };
}

// ─── Main seeding routine ────────────────────────────────────────────
async function seedTimeseriesLarge() {
  try {
    await connect();
    const tsCol = await getTimeseriesCollection();

    // Ensure timeseries collection exists
    await ensureTimeseriesCollection();

    // Load ships from ctrack_data (matching suids)
    const ships = await loadShipsFromCtrack();

    logger.info('SEED-TS', `Starting to seed ${TOTAL_DOCS.toLocaleString()} timeseries documents...`);
    logger.info('SEED-TS', `${ships.length} ships × ${DOCS_PER_SHIP} docs each, spread over last ${DAYS_BACK} days`);

    const now = new Date();
    const startDate = new Date(now.getTime() - DAYS_BACK * 86400000);
    const timeRangeMs = DAYS_BACK * 86400000;
    
    const totalBatches = Math.ceil(TOTAL_DOCS / BATCH_SIZE);
    let totalInserted = 0;
    const startTime = Date.now();

    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * BATCH_SIZE;
      const batchEnd   = Math.min(batchStart + BATCH_SIZE, TOTAL_DOCS);
      const batchSize  = batchEnd - batchStart;

      const tsDocs = [];

      for (let i = batchStart; i < batchEnd; i++) {
        // Evenly distribute timestamps across the time range
        const progressRatio = i / TOTAL_DOCS;
        const timestamp = new Date(startDate.getTime() + progressRatio * timeRangeMs);
        
        // Cycle through ships
        const shipIdx = i % ships.length;
        const ship = ships[shipIdx];

        const doc = generateTimeseriesDoc(ship, timestamp);
        tsDocs.push(doc);
      }

      const batchTime = Date.now();

      // Insert batch
      await tsCol.insertMany(tsDocs, { ordered: false });

      const batchDuration = Date.now() - batchTime;
      totalInserted += batchSize;
      const pct  = ((totalInserted / TOTAL_DOCS) * 100).toFixed(2);
      const rate = Math.round(batchSize / (batchDuration / 1000));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const avgRate = Math.round(totalInserted / (elapsed || 1));

      logger.info('SEED-TS',
        `Batch ${b+1}/${totalBatches} | ${totalInserted.toLocaleString()}/${TOTAL_DOCS.toLocaleString()} (${pct}%) | ` +
        `${rate.toLocaleString()} docs/sec (batch) | ${avgRate.toLocaleString()} docs/sec (avg)`
      );
    }

    const totalDuration = Date.now() - startTime;
    const totalSeconds = totalDuration / 1000;
    const finalRate = Math.round(TOTAL_DOCS / totalSeconds);

    logger.info('SEED-TS', '═══════════════════════════════════════════');
    logger.info('SEED-TS', `✓ Seeding complete!`);
    logger.info('SEED-TS', `Total inserted: ${TOTAL_DOCS.toLocaleString()} documents`);
    logger.info('SEED-TS', `Total time: ${Math.floor(totalSeconds / 60)}m ${Math.round(totalSeconds % 60)}s`);
    logger.info('SEED-TS', `Average rate: ${finalRate.toLocaleString()} docs/sec`);
    logger.info('SEED-TS', `Date range: ${startDate.toISOString()} to ${now.toISOString()}`);
    logger.info('SEED-TS', '═══════════════════════════════════════════');

    await disconnect();

  } catch (err) {
    logger.error('SEED-TS', `Error: ${err.message}`, err);
    await disconnect();
    process.exit(1);
  }
}

seedTimeseriesLarge();
