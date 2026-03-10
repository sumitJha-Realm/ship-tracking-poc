const { Long } = require('mongodb');
const { connect, getCollection, getTimeseriesCollection, ensureTimeseriesCollection, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────
const TOTAL_SHIPS = 1000;
const BATCH_SIZE = 500;

// ─── Nationality codes (MID codes used in MMSI) ─────────────────────
const NATIONALITIES = [
  273, 419, 501, 502, 503, 504, 505, 506, 508, 510,
  511, 512, 514, 515, 516, 518, 519, 520, 538,
];

// ─── Ship name word pools (50 × 50 = 2,500 base names) ──────────────
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

// ─── Build the 125K ship registry ────────────────────────────────────
function buildShipRegistry() {
  logger.info('SEED', 'Building ship registry...');
  const baseNameCount = FIRST_WORDS.length * SECOND_WORDS.length; // 2500
  const ships = [];
  const natSeq = {};
  NATIONALITIES.forEach(n => { natSeq[n] = 0; });

  const seedTime = new Date();

  for (let i = 0; i < TOTAL_SHIPS; i++) {
    // Name: "Northern Voyager", "Northern Voyager 2", ...
    const baseIdx = i % baseNameCount;
    const suffix  = Math.floor(i / baseNameCount);
    const first   = FIRST_WORDS[baseIdx % FIRST_WORDS.length];
    const second  = SECOND_WORDS[Math.floor(baseIdx / FIRST_WORDS.length)];
    const shipName = suffix === 0 ? `${first} ${second}` : `${first} ${second} ${suffix + 1}`;

    // Nationality & MMSI
    const nat = NATIONALITIES[i % NATIONALITIES.length];
    natSeq[nat]++;
    const mmsi = parseInt(`${nat}${String(natSeq[nat]).padStart(6, '0')}`);

    // Stable SUID (generated once at creation)
    const creationTime = new Date(seedTime.getTime() - randomInt(0, 30 * 86400000));
    const suid = formatSuid(mmsi, creationTime);

    // Place in a random maritime zone
    const zone = ZONES[i % ZONES.length];
    const lat = randomFloat(zone.latMin, zone.latMax);
    const lng = randomFloat(zone.lngMin, zone.lngMax);

    // Static vessel properties
    const vesselLength = randomInt(50, 400);
    const vesselWidth  = randomInt(8, 65);
    const shipType     = randomItem(SHIP_TYPES);
    const imoNo        = randomInt(1000000, 9999999);
    const survLocId    = randomItem(SURV_LOC_IDS);
    const sensorType   = randomItem(SENSOR_TYPES);
    const cargoType    = randomItem(CARGO_TYPES);
    const draught      = parseFloat(randomFloat(3, 20).toFixed(1));
    const callSign     = `${String.fromCharCode(65+randomInt(0,25))}${String.fromCharCode(65+randomInt(0,25))}${randomInt(100,999)}`;

    ships.push({
      idx: i, suid, mmsi, shipName, nat, lat, lng,
      vesselLength, vesselWidth, shipType, imoNo, survLocId,
      sensorType, cargoType, draught, callSign,
      lengthBow: Math.floor(vesselLength * 0.15),
      lengthStern: vesselLength - Math.floor(vesselLength * 0.15),
      speed: parseFloat(randomFloat(0, 25).toFixed(2)),
      course: randomInt(0, 359),
    });
  }

  logger.info('SEED', `Registry built: ${ships.length.toLocaleString()} ships`);
  return ships;
}

// ─── Generate a full CTRACK document (matches real schema) ───────────
function generateCtrackDoc(ship, now) {
  const timeStr     = formatCtrackDate(now);
  const createdStr  = timeStr + String(randomInt(10, 99)); // extra digits like sample

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
    remarks: randomItem(REMARKS_POOL),
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
    // App-level fields
    trackLocation: { type: 'Point', coordinates: [ship.lng, ship.lat] },
  };
}

// ─── Main seed routine ───────────────────────────────────────────────
async function seedData() {
  try {
    await connect();
    const ctrackCol = await getCollection();
    const tsCol     = await getTimeseriesCollection();

    // Ensure timeseries collection exists
    await ensureTimeseriesCollection();

    // Check existing
    const existingCount = await ctrackCol.countDocuments();
    if (existingCount >= TOTAL_SHIPS) {
      logger.info('SEED', `ctrack_data already has ${existingCount} docs. Run "npm run reset" to re-seed.`);
      return;
    }
    if (existingCount > 0) {
      logger.info('SEED', `Clearing ${existingCount} existing ctrack_data docs...`);
      await ctrackCol.deleteMany({});
    }

    // Build ship registry
    const ships = buildShipRegistry();

    logger.info('SEED', `Seeding ${TOTAL_SHIPS.toLocaleString()} ships into ctrack_data + timeseries...`);

    const totalBatches = Math.ceil(TOTAL_SHIPS / BATCH_SIZE);
    let totalInserted = 0;
    const startTime = Date.now();

    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * BATCH_SIZE;
      const batchEnd   = Math.min(batchStart + BATCH_SIZE, TOTAL_SHIPS);
      const now = new Date();

      const ctrackDocs = [];
      const tsDocs     = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const doc = generateCtrackDoc(ships[i], now);
        ctrackDocs.push(doc);

        // Timeseries doc: same but without trackLocation (raw CTRACK)
        const tsDoc = { ...doc };
        delete tsDoc.trackLocation;
        tsDocs.push(tsDoc);
      }

      const batchTime = Date.now();

      // Dual-write: ctrack_data + timeseries
      await Promise.all([
        ctrackCol.insertMany(ctrackDocs, { ordered: false }),
        tsCol.insertMany(tsDocs, { ordered: false }),
      ]);

      const batchDuration = Date.now() - batchTime;
      totalInserted += ctrackDocs.length;
      const pct  = ((totalInserted / TOTAL_SHIPS) * 100).toFixed(1);
      const rate = Math.round(ctrackDocs.length / (batchDuration / 1000));

      logger.info('SEED',
        `Batch ${b+1}/${totalBatches} | ${totalInserted.toLocaleString()}/${TOTAL_SHIPS.toLocaleString()} (${pct}%) | ${rate.toLocaleString()} docs/sec`
      );
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgRate = Math.round(totalInserted / parseFloat(totalDuration));

    logger.info('SEED', '─── Seeding Complete ───');
    logger.info('SEED', `  ship_tracking.ctrack_data    : ${totalInserted.toLocaleString()} docs`);
    logger.info('SEED', `  CTRACK.tracks_local_timeseries: ${totalInserted.toLocaleString()} initial entries`);
    logger.info('SEED', `  Total time: ${totalDuration}s  |  Avg rate: ${avgRate.toLocaleString()} docs/sec`);
  } catch (error) {
    logger.error('SEED', 'Seeding failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await disconnect();
  }
}

seedData();
