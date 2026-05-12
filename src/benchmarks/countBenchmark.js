const { MongoClient } = require('mongodb');
require('dotenv').config();

async function run() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db('ship_tracking');

  const collName = 'tracks_local_timeseries';
  const days = 60;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log('Collection: ' + collName + ', Last ' + days + ' days');
  console.log('Cutoff: ' + cutoff.toISOString());
  console.log('');

  // Method 1: countDocuments (no hint - lets MongoDB use internal bucket optimization)
  const t1 = process.hrtime.bigint();
  const r1 = await db.collection(collName).countDocuments({ reported_time_info: { $gte: cutoff } });
  const t1ms = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('countDocuments:       ' + r1 + ' docs, Time: ' + t1ms.toFixed(2) + ' ms');

  // Method 2: countDocuments WITH ascending index hint
  const t2 = process.hrtime.bigint();
  const r2 = await db.collection(collName).countDocuments(
    { reported_time_info: { $gte: cutoff } },
    { hint: { reported_time_info: 1 } }
  );
  const t2ms = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log('countDocs + hint:     ' + r2 + ' docs, Time: ' + t2ms.toFixed(2) + ' ms');

  // Method 3: aggregate $match + $count
  const t3 = process.hrtime.bigint();
  const r3 = await db.collection(collName).aggregate([
    { $match: { reported_time_info: { $gte: cutoff } } },
    { $count: 'total' }
  ]).toArray();
  const t3ms = Number(process.hrtime.bigint() - t3) / 1e6;
  console.log('aggregate $count:     ' + (r3[0]?.total || 0) + ' docs, Time: ' + t3ms.toFixed(2) + ' ms');

  // Method 4: system.buckets (approximate but fast)
  const t4 = process.hrtime.bigint();
  const r4 = await db.collection('system.buckets.' + collName).aggregate([
    { $match: { 'control.min.reported_time_info': { $gte: cutoff } } },
    { $group: { _id: null, total: { $sum: '$control.count' } } }
  ]).toArray();
  const t4ms = Number(process.hrtime.bigint() - t4) / 1e6;
  console.log('system.buckets:       ' + (r4[0]?.total || 0) + ' docs, Time: ' + t4ms.toFixed(2) + ' ms');

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('RESULTS:');
  console.log('  countDocuments:       ' + t1ms.toFixed(2) + ' ms  →  ' + r1.toLocaleString() + ' docs');
  console.log('  countDocs + hint:     ' + t2ms.toFixed(2) + ' ms  →  ' + r2.toLocaleString() + ' docs');
  console.log('  aggregate $count:     ' + t3ms.toFixed(2) + ' ms  →  ' + (r3[0]?.total || 0).toLocaleString() + ' docs');
  console.log('  system.buckets:       ' + t4ms.toFixed(2) + ' ms  →  ' + (r4[0]?.total || 0).toLocaleString() + ' docs (approximate)');
  console.log('═══════════════════════════════════════════');

  const times = [t1ms, t2ms, t3ms, t4ms];
  const labels = ['countDocuments', 'countDocs+hint', 'aggregate $count', 'system.buckets'];
  const minIdx = times.indexOf(Math.min(...times));
  console.log('Fastest: ' + labels[minIdx] + ' (' + times[minIdx].toFixed(0) + ' ms)');

  await client.close();
}

run().catch(e => { console.error(e.message); process.exit(1); });
