/**
 * MongoDB Connector for CTRACK ArcGIS CDF Provider
 * Handles connection pooling, queries, and Decimal128 → float conversion
 */
const { MongoClient } = require('mongodb');
const { NATIONALITY_COLORS } = require('./field-definitions');

let client = null;
let db = null;
let collection = null;

/**
 * Connect to MongoDB
 */
async function connect(config) {
  if (db) return;

  const { uri, database, collection: colName } = config;
  client = new MongoClient(uri, {
    maxPoolSize: 50,
    minPoolSize: 5,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    retryWrites: true,
    retryReads: true,
  });

  await client.connect();
  db = client.db(database);
  collection = db.collection(colName);
  await db.command({ ping: 1 });
  console.log(`[CDF-MongoDB] Connected to ${database}.${colName}`);
}

/**
 * Disconnect
 */
async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    collection = null;
    console.log('[CDF-MongoDB] Disconnected');
  }
}

/**
 * Unwrap MongoDB Decimal128 to plain float
 */
function unwrapDecimal(val) {
  if (val && val.$numberDecimal !== undefined) return parseFloat(val.$numberDecimal);
  if (val && typeof val.toString === 'function' && val._bsontype === 'Decimal128') {
    return parseFloat(val.toString());
  }
  return val;
}

/**
 * Safely convert a BSON Long / object to plain number
 */
function toLong(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && typeof val.toNumber === 'function') return val.toNumber();
  return parseInt(val.toString()) || 0;
}

/**
 * Convert a MongoDB CTRACK document → flat properties object for Esri.
 * vessel_info fields are extracted from the first element of the array.
 */
function toEsriProperties(doc, index) {
  const nat = toLong(doc.nationality);
  const vi  = (doc.vessel_info && doc.vessel_info[0]) || {};

  return {
    _oid: index + 1,
    suid: doc.suid,
    ship_name: doc.ship_name || '',
    mmsi_number: toLong(doc.mmsi_number),
    imo_no: toLong(vi.imo_no),
    nationality: nat,
    ship_type: toLong(vi.ship_type),
    latitude: typeof doc.latitude === 'number' ? doc.latitude : unwrapDecimal(doc.latitude),
    longitude: typeof doc.longitude === 'number' ? doc.longitude : unwrapDecimal(doc.longitude),
    speed: typeof doc.speed === 'number' ? doc.speed : unwrapDecimal(doc.speed),
    course: toLong(doc.course),
    heading: toLong(doc.course),
    rate_of_turn: toLong(vi.rate_of_turn),
    navigational_status: toLong(vi.navigational_status),
    draught: typeof vi.draught === 'number' ? vi.draught : toLong(vi.draught),
    total_vessel_length: toLong(vi.total_vessel_length),
    total_vessel_width: toLong(vi.total_vessel_width),
    length_bow: toLong(vi.length_bow),
    length_stream: toLong(vi.length_stream),
    width_port: toLong(vi.width_port),
    width_starboard: toLong(vi.width_starboard),
    threat_score: toLong(doc.threat_score),
    vigilance_score: toLong(doc.vigilance_score),
    css_track_quality: toLong(doc.css_track_quality),
    css_track_status: toLong(doc.css_track_status),
    css_track_class: toLong(doc.classification_info_css_trk_class),
    csscategory: toLong(doc.classification_info_css_category),
    cargo_type: toLong(vi.cargo_type),
    no_of_surv: toLong(doc.no_of_surv),
    no_contrib: toLong(doc.no_contrib),
    toi_flag: toLong(doc.toi_flag),
    sticky_flag: toLong(doc.sticky_flag),
    nsc_validity_flag: toLong(doc.nsc_validity_flag),
    remarks: doc.remarks || '',
    sensor_type_list: String(toLong(doc.interface_sensor_type)),
    data_source: String(toLong(doc.interface_sensor_type)),
    reported_time_info: doc.reported_time_info ? new Date(doc.reported_time_info).getTime() : null,
    created_time_info: doc.created_time_info ? new Date(doc.created_time_info).getTime() : null,
    system_updated_time_info: doc.system_updated_time_info ? new Date(doc.system_updated_time_info).getTime() : null,
    color: NATIONALITY_COLORS[nat] || '#FFFFFF',
  };
}

/**
 * Query features from MongoDB
 * Returns { features, count }
 */
async function queryFeatures(options = {}) {
  if (!collection) throw new Error('Not connected to MongoDB');

  const {
    where,
    geometry,       // { xmin, ymin, xmax, ymax } or null
    limit = 5000,
    offset = 0,
    orderBy,        // e.g. 'reported_time_info DESC'
    returnCountOnly = false,
  } = options;

  // Build MongoDB query filter
  const filter = {};

  // Parse simple where clause (e.g. "nationality = 515")
  if (where && where !== '1=1') {
    const match = where.match(/^(\w+)\s*=\s*'?(\w+)'?$/);
    if (match) {
      const [, field, value] = match;
      filter[field] = isNaN(value) ? value : parseInt(value);
    }
  }

  // Spatial filter (envelope/bbox)
  if (geometry && geometry.xmin !== undefined) {
    filter.trackLocation = {
      $geoWithin: {
        $geometry: {
          type: 'Polygon',
          coordinates: [[
            [geometry.xmin, geometry.ymin],
            [geometry.xmin, geometry.ymax],
            [geometry.xmax, geometry.ymax],
            [geometry.xmax, geometry.ymin],
            [geometry.xmin, geometry.ymin],
          ]],
        },
      },
    };
  }

  // Count only
  if (returnCountOnly) {
    const count = await collection.countDocuments(filter);
    return { count, features: [] };
  }

  // Build sort
  let sort = { reported_time_info: -1 };
  if (orderBy) {
    const parts = orderBy.split(' ');
    sort = { [parts[0]]: parts[1]?.toUpperCase() === 'ASC' ? 1 : -1 };
  }

  // Execute query
  const docs = await collection
    .find(filter)
    .sort(sort)
    .skip(offset)
    .limit(limit)
    .toArray();

  // Convert to Esri features
  const features = docs.map((doc, i) => {
    const props = toEsriProperties(doc, offset + i);
    return {
      attributes: props,
      geometry: {
        x: props.longitude,
        y: props.latitude,
        spatialReference: { wkid: 4326 },
      },
    };
  });

  const count = await collection.countDocuments(filter);
  return { features, count };
}

/**
 * Get the full extent of all track locations
 */
async function getExtent() {
  if (!collection) throw new Error('Not connected');

  const [result] = await collection.aggregate([
    {
      $group: {
        _id: null,
        minLng: { $min: { $arrayElemAt: ['$trackLocation.coordinates', 0] } },
        maxLng: { $max: { $arrayElemAt: ['$trackLocation.coordinates', 0] } },
        minLat: { $min: { $arrayElemAt: ['$trackLocation.coordinates', 1] } },
        maxLat: { $max: { $arrayElemAt: ['$trackLocation.coordinates', 1] } },
      },
    },
  ]).toArray();

  if (!result) {
    return { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } };
  }

  return {
    xmin: result.minLng,
    ymin: result.minLat,
    xmax: result.maxLng,
    ymax: result.maxLat,
    spatialReference: { wkid: 4326 },
  };
}

module.exports = {
  connect,
  disconnect,
  queryFeatures,
  getExtent,
  unwrapDecimal,
  toEsriProperties,
};
