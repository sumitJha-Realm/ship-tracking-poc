const http = require('http');
const logger = require('../src/utils/logger');

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const CONCURRENT_REQUESTS = 20;
const TOTAL_REQUESTS = 200;
const TEST_USER = 'load-test-user';

let completed = 0;
let errors = 0;
let latencies = [];

function makeRequest(path) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(path, BASE_URL);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'x-user-id': TEST_USER },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const latency = Date.now() - start;
        latencies.push(latency);
        completed++;
        resolve({ status: res.statusCode, latency, size: data.length });
      });
    });

    req.on('error', (err) => {
      errors++;
      completed++;
      resolve({ status: 0, latency: Date.now() - start, error: err.message });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      errors++;
      completed++;
      resolve({ status: 0, latency: 30000, error: 'timeout' });
    });

    req.end();
  });
}

async function runTest(name, path, count) {
  console.log(`\n--- ${name} ---`);
  console.log(`  Path: ${path}`);
  console.log(`  Requests: ${count} (${CONCURRENT_REQUESTS} concurrent)`);

  completed = 0;
  errors = 0;
  latencies = [];
  const start = Date.now();

  // Run in batches of concurrent requests
  for (let i = 0; i < count; i += CONCURRENT_REQUESTS) {
    const batch = Math.min(CONCURRENT_REQUESTS, count - i);
    const promises = [];
    for (let j = 0; j < batch; j++) {
      promises.push(makeRequest(path));
    }
    await Promise.all(promises);
  }

  const totalTime = Date.now() - start;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const avg = sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
  const rps = Math.round((count / totalTime) * 1000);

  console.log(`  Results:`);
  console.log(`    Total time:  ${totalTime}ms`);
  console.log(`    Requests/s:  ${rps}`);
  console.log(`    Errors:      ${errors}`);
  console.log(`    Latency avg: ${avg}ms`);
  console.log(`    Latency P50: ${p50}ms`);
  console.log(`    Latency P95: ${p95}ms`);
  console.log(`    Latency P99: ${p99}ms`);

  return { name, rps, avg, p50, p95, p99, errors };
}

async function main() {
  console.log('====================================');
  console.log('  Ship Tracking - Load Test');
  console.log('====================================');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Total requests per test: ${TOTAL_REQUESTS}`);
  console.log(`  Concurrency: ${CONCURRENT_REQUESTS}`);

  const results = [];

  // Test 1: Health check
  results.push(await runTest('Health Check', '/health', TOTAL_REQUESTS));

  // Test 2: Get tracks (default)
  results.push(await runTest('GET /tracks (default)', '/tracks?limit=100', TOTAL_REQUESTS));

  // Test 3: Get tracks with nationality filter
  results.push(await runTest('GET /tracks (filtered)', '/tracks?limit=100&nationality=419', TOTAL_REQUESTS));

  // Test 4: Get stats
  results.push(await runTest('GET /tracks/stats', '/tracks/stats', Math.floor(TOTAL_REQUESTS / 4)));

  // Test 5: Geospatial overlay
  const polygon = encodeURIComponent(
    JSON.stringify({
      type: 'Polygon',
      coordinates: [[[0, 0], [0, 45], [45, 45], [45, 0], [0, 0]]],
    })
  );
  results.push(await runTest('GET /tracks/overlay', `/tracks/overlay?polygon=${polygon}`, Math.floor(TOTAL_REQUESTS / 2)));

  // Summary
  console.log('\n====================================');
  console.log('  SUMMARY');
  console.log('====================================');
  console.log('');
  console.log(`  ${'Test'.padEnd(30)} ${'RPS'.padStart(6)} ${'Avg'.padStart(6)} ${'P95'.padStart(6)} ${'P99'.padStart(6)} ${'Err'.padStart(5)}`);
  console.log('  ' + '-'.repeat(65));
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(30)} ${String(r.rps).padStart(6)} ${(r.avg + 'ms').padStart(6)} ${(r.p95 + 'ms').padStart(6)} ${(r.p99 + 'ms').padStart(6)} ${String(r.errors).padStart(5)}`
    );
  }
  console.log('');
}

main().catch(console.error);
