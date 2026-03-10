const { MongoClient } = require('mongodb');
require('dotenv').config();

// ─── Connection ──────────────────────────────────────────────────────
const MONGO_URI = 'mongodb://127.0.0.1:35010/?directConnection=true';

// Database: ship_tracking  → latest CTRACK state per ship
const DB_NAME = process.env.DB_NAME || 'ship_tracking';
const COLLECTION_NAME = 'ctrack_data';

// Database: CTRACK  → full historical timeseries
const CTRACK_DB_NAME = 'CTRACK';
const TIMESERIES_COLLECTION = 'tracks_local_timeseries';

const clientOptions = {
  maxPoolSize: 150,
  minPoolSize: 10,
  maxIdleTimeMS: 30000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  retryWrites: true,
  retryReads: true,
};

let client = null;
let db = null;        // ship_tracking
let ctrackDb = null;  // CTRACK

async function connect() {
  if (db) return { client, db };

  try {
    client = new MongoClient(MONGO_URI, clientOptions);
    await client.connect();
    db = client.db(DB_NAME);
    ctrackDb = client.db(CTRACK_DB_NAME);

    await db.command({ ping: 1 });
    console.log(`[DB] Connected to MongoDB: ${DB_NAME} + ${CTRACK_DB_NAME}`);

    return { client, db };
  } catch (error) {
    console.error('[DB] Connection failed:', error.message);
    throw error;
  }
}

async function getCollection() {
  if (!db) await connect();
  return db.collection(COLLECTION_NAME);
}

async function getRemarksCollection() {
  if (!db) await connect();
  return db.collection('ship_remarks');
}

async function getDb() {
  if (!db) await connect();
  return db;
}

async function getCtrackDb() {
  if (!ctrackDb) await connect();
  return ctrackDb;
}

async function getTimeseriesCollection() {
  if (!ctrackDb) await connect();
  return ctrackDb.collection(TIMESERIES_COLLECTION);
}

/**
 * Create the timeseries collection if it does not exist.
 * metaField = suid  (groups history per ship)
 * timeField = reported_time_info
 */
async function ensureTimeseriesCollection() {
  if (!ctrackDb) await connect();
  const cols = await ctrackDb.listCollections({ name: TIMESERIES_COLLECTION }).toArray();
  if (cols.length === 0) {
    await ctrackDb.createCollection(TIMESERIES_COLLECTION, {
      timeseries: {
        timeField: 'reported_time_info',
        metaField: 'suid',
        granularity: 'seconds',
      },
    });
    console.log(`[DB] Created timeseries: ${CTRACK_DB_NAME}.${TIMESERIES_COLLECTION}`);
  } else {
    console.log(`[DB] Timeseries already exists: ${CTRACK_DB_NAME}.${TIMESERIES_COLLECTION}`);
  }
}

async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    ctrackDb = null;
    console.log('[DB] Disconnected from MongoDB');
  }
}

module.exports = {
  connect,
  getCollection,
  getRemarksCollection,
  getDb,
  getCtrackDb,
  getTimeseriesCollection,
  ensureTimeseriesCollection,
  disconnect,
  COLLECTION_NAME,
  DB_NAME,
  CTRACK_DB_NAME,
  TIMESERIES_COLLECTION,
};
