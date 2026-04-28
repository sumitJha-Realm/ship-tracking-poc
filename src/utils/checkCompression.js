/**
 * Check TimeSeries Compression Ratio — Full Breakdown
 *
 * Usage:  node src/utils/checkCompression.js
 */
const { connect, getTimeseriesCollection, getCtrackDb, disconnect } = require('./db');

(async () => {
  try {
    await connect();
    const ts = await getTimeseriesCollection();
    const ctrackDb = await getCtrackDb();

    const count = await ts.countDocuments({});

    if (count === 0) {
      console.log('\n  No documents in timeseries collection. Run ingestion first.\n');
      await disconnect();
      return;
    }

    // 1. BSON size — what your app writes (full document on the wire)
    const bson = (await ts.aggregate([
      { $sample: { size: Math.min(count, 5000) } },
      { $project: { s: { $bsonSize: '$$ROOT' } } },
      { $group: { _id: null, avg: { $avg: '$s' }, min: { $min: '$s' }, max: { $max: '$s' }, cnt: { $sum: 1 } } }
    ]).toArray())[0];

    // 2. collStats — on-disk sizes
    const colStats = (await ts.aggregate([
      { $collStats: { storageStats: {} } }
    ]).toArray())[0].storageStats;

    const storageSize = colStats.storageSize || 0;
    const indexSize   = colStats.totalIndexSize || 0;
    const logicalSize = colStats.size || 0;
    const totalDisk   = storageSize + indexSize;

    // 3. TimeSeries internal stats
    const tsStats       = colStats.timeseries || {};
    const tsUncompBytes = tsStats.numBytesUncompressed || 0;
    const tsCompBytes   = tsStats.numBytesCompressed || 0;
    const tsBuckets     = tsStats.bucketCount || 0;
    const tsDocs        = tsStats.numMeasurementsCommitted || count;

    // Per-doc calculations
    const bsonPerDoc      = bson.avg;                   // A: raw BSON
    const tsInternalPerDoc = tsUncompBytes / tsDocs;     // B: TS internal
    const logicalPerDoc   = logicalSize / count;          // C: bucketed logical
    const storagePerDoc   = storageSize / count;          // D: on-disk
    const totalPerDoc     = totalDisk / count;            // D+idx: on-disk + indexes
    const bsonTotal       = bson.avg * count;

    const GB = 1073741824;
    const TB = 1099511627776;
    const fmt = (b) => {
      if (b >= TB) return (b / TB).toFixed(2) + ' TB';
      if (b >= GB) return (b / GB).toFixed(2) + ' GB';
      if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
      return (b / 1024).toFixed(2) + ' KB';
    };

    console.log('');
    console.log('  CTRACK TimeSeries — Full Compression Breakdown');
    console.log('  ═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Documents:       ' + count.toLocaleString());
    console.log('  Buckets:         ' + tsBuckets.toLocaleString() + '  (~' + Math.round(tsDocs / (tsBuckets || 1)) + ' docs/bucket)');
    console.log('  Sampled:         ' + bson.cnt.toLocaleString());
    console.log('');
    console.log('  DATA AT EACH STAGE');
    console.log('  ───────────────────────────────────────────────────────────');
    console.log('  A. $bsonSize (raw BSON)          ' + bsonPerDoc.toFixed(0).padStart(6) + ' bytes/doc    ' + fmt(bsonTotal).padStart(10));
    console.log('     What your app writes on the wire.');
    console.log('');
    console.log('  B. TS Internal (numBytesUncomp)  ' + Math.round(tsInternalPerDoc).toString().padStart(6) + ' bytes/doc    ' + fmt(tsUncompBytes).padStart(10));
    console.log('     Field names stored once per bucket, not per doc.');
    console.log('');
    console.log('  C. Logical (stats.size)          ' + Math.round(logicalPerDoc).toString().padStart(6) + ' bytes/doc    ' + fmt(logicalSize).padStart(10));
    console.log('     After full TS bucketing + columnar layout.');
    console.log('');
    console.log('  D. Storage (stats.storageSize)   ' + Math.round(storagePerDoc).toString().padStart(6) + ' bytes/doc    ' + fmt(storageSize).padStart(10));
    console.log('     On-disk after WiredTiger snappy compression.');
    console.log('');
    console.log('     Indexes (totalIndexSize)      ' + (indexSize / count).toFixed(1).padStart(6) + ' bytes/doc    ' + fmt(indexSize).padStart(10));
    console.log('     Total on disk (D + indexes)   ' + Math.round(totalPerDoc).toString().padStart(6) + ' bytes/doc    ' + fmt(totalDisk).padStart(10));
    console.log('');
    console.log('  COMPRESSION PIPELINE');
    console.log('  ───────────────────────────────────────────────────────────');
    console.log('  ' + bsonPerDoc.toFixed(0) + ' B ──▶ ' + Math.round(tsInternalPerDoc) + ' B ──▶ ' + Math.round(logicalPerDoc) + ' B ──▶ ' + Math.round(storagePerDoc) + ' B');
    console.log('  (A)       (B)        (C)        (D)');
    console.log('');
    console.log('  COMPRESSION RATIOS');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  A÷D  $bsonSize → disk (end-to-end):   ' + (bsonPerDoc / storagePerDoc).toFixed(1).padStart(6) + ' : 1     │');
    console.log('  │  B÷D  TS internal → disk ($collStats):  ' + (tsInternalPerDoc / storagePerDoc).toFixed(1).padStart(5) + ' : 1     │');
    console.log('  │  C÷D  Logical → disk (stats()/Compass): ' + (logicalPerDoc / storagePerDoc).toFixed(1).padStart(5) + ' : 1     │');
    console.log('  │  A÷(D+idx) $bsonSize → total on disk:  ' + (bsonPerDoc / totalPerDoc).toFixed(1).padStart(5) + ' : 1     │');
    console.log('  │                                                          │');
    console.log('  │  Space Saved (A vs D+idx):             ' + ((1 - totalDisk / bsonTotal) * 100).toFixed(1).padStart(6) + ' %      │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('  USE FOR SIZING:  ' + (bsonPerDoc / storagePerDoc).toFixed(1) + ' : 1  (' + bsonPerDoc.toFixed(0) + ' B → ' + Math.round(storagePerDoc) + ' B per doc)');
    console.log('');
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await disconnect();
  }
})();
