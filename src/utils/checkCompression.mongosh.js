/**
 * Run in mongosh:
 *   mongosh "mongodb://localhost:27017" --file src/utils/checkCompression.mongosh.js
 *   
 * Or paste directly into mongosh shell
 */

// ── Config ──
const DB_NAME = "CTRACK";
const COLLECTION = "tracks_local_timeseries";
const SAMPLE_SIZE = 5000;

// ── Get references ──
const col = db.getSiblingDB(DB_NAME).getCollection(COLLECTION);
const count = col.countDocuments({});

if (count === 0) {
  print("\n  No documents found. Run ingestion first.\n");
  quit();
}

// ── Layer 1: Raw BSON size (what your app writes) ──
const bsonResult = col.aggregate([
  { $sample: { size: Math.min(count, SAMPLE_SIZE) } },
  { $project: { s: { $bsonSize: "$$ROOT" } } },
  { $group: {
    _id: null,
    avg: { $avg: "$s" },
    min: { $min: "$s" },
    max: { $max: "$s" },
    cnt: { $sum: 1 }
  }}
]).toArray()[0];

const bsonTotal = bsonResult.avg * count;

// ── Layer 2 & 3: collStats (logical + storage) ──
const stats = col.stats();
const logicalSize  = stats.size;          // After TS bucketing (uncompressed buckets)
const storageSize  = stats.storageSize;   // After WiredTiger compression (on-disk)
const indexSize    = stats.totalIndexSize;
const totalOnDisk  = storageSize + indexSize;

// ── Ratios ──
const bucketingRatio   = bsonTotal / logicalSize;        // TS bucketing only
const wtRatio          = logicalSize / storageSize;      // WiredTiger snappy only
const totalDataRatio   = bsonTotal / storageSize;        // End-to-end (data only)
const totalWithIdxRatio = bsonTotal / totalOnDisk;       // End-to-end (data + indexes)
const spaceSaved       = (1 - totalOnDisk / bsonTotal) * 100;

// ── Format helper ──
function fmt(bytes) {
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(2) + " TB";
  if (bytes >= 1073741824)    return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576)       return (bytes / 1048576).toFixed(2) + " MB";
  return (bytes / 1024).toFixed(2) + " KB";
}

// ── Output ──
print("");
print("  CTRACK TimeSeries — Full Compression Analysis");
print("  ══════════════════════════════════════════════════════════");
print("");
print("  Collection:          " + DB_NAME + "." + COLLECTION);
print("  Documents:           " + count.toLocaleString());
print("  Sampled:             " + bsonResult.cnt.toLocaleString());
print("");
print("  ┌──────────────────────────────────────────────────────────┐");
print("  │  SIZE AT EACH STAGE                                     │");
print("  ├──────────────────────────────────────────────────────────┤");
print("  │                                                          │");
print("  │  1. Raw BSON ($bsonSize)        — what your app writes  │");
print("  │     Per doc:    " + bsonResult.avg.toFixed(0) + " bytes  (" + (bsonResult.avg/1024).toFixed(2) + " KB)");
print("  │     Total:      " + fmt(bsonTotal));
print("  │                        ↓  TimeSeries Bucketing          │");
print("  │  2. Logical (stats.size)        — after TS bucketing    │");
print("  │     Per doc:    " + (logicalSize/count).toFixed(0) + " bytes  (" + (logicalSize/count/1024).toFixed(2) + " KB)");
print("  │     Total:      " + fmt(logicalSize));
print("  │                        ↓  WiredTiger Snappy             │");
print("  │  3. Storage (stats.storageSize) — actual on-disk        │");
print("  │     Per doc:    " + (storageSize/count).toFixed(0) + " bytes  (" + (storageSize/count/1024).toFixed(3) + " KB)");
print("  │     Total:      " + fmt(storageSize));
print("  │                                                          │");
print("  │  4. Indexes (stats.totalIndexSize)                      │");
print("  │     Per doc:    " + (indexSize/count).toFixed(1) + " bytes");
print("  │     Total:      " + fmt(indexSize));
print("  │                                                          │");
print("  │  5. Total On-Disk (storage + indexes)                   │");
print("  │     Per doc:    " + (totalOnDisk/count).toFixed(0) + " bytes");
print("  │     Total:      " + fmt(totalOnDisk));
print("  └──────────────────────────────────────────────────────────┘");
print("");
print("  ┌──────────────────────────────────────────────────────────┐");
print("  │  COMPRESSION RATIOS                                     │");
print("  ├──────────────────────────────────────────────────────────┤");
print("  │                                                          │");
print("  │  Layer 1: TS Bucketing only       " + bucketingRatio.toFixed(1).padStart(6) + " : 1            │");
print("  │           " + bsonResult.avg.toFixed(0) + " B → " + (logicalSize/count).toFixed(0) + " B per doc");
print("  │                                                          │");
print("  │  Layer 2: WiredTiger Snappy only   " + wtRatio.toFixed(1).padStart(5) + " : 1            │");
print("  │           " + (logicalSize/count).toFixed(0) + " B → " + (storageSize/count).toFixed(0) + " B per doc");
print("  │                                                          │");
print("  │  ════════════════════════════════════════════════════    │");
print("  │                                                          │");
print("  │  Total (data only):               " + totalDataRatio.toFixed(1).padStart(6) + " : 1            │");
print("  │           " + bsonResult.avg.toFixed(0) + " B → " + (storageSize/count).toFixed(0) + " B per doc");
print("  │                                                          │");
print("  │  Total (data + indexes):          " + totalWithIdxRatio.toFixed(1).padStart(6) + " : 1            │");
print("  │           " + bsonResult.avg.toFixed(0) + " B → " + (totalOnDisk/count).toFixed(0) + " B per doc");
print("  │                                                          │");
print("  │  Space Saved:                     " + spaceSaved.toFixed(1).padStart(6) + " %             │");
print("  └──────────────────────────────────────────────────────────┘");
print("");
