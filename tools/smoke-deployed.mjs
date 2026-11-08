// Verifies the deployed service, not the one we think we deployed.
//
// This exists as a Node script rather than shell lines in the workflow so the
// exact same code can be run locally against a live URL before it is trusted in
// CI. A green deploy that still served the previous build has happened in this
// repository, and so has a SPA built without its Firebase config: neither is
// visible from the deploy command's exit code, so both are asserted here.
//
// Usage: node tools/smoke-deployed.mjs https://service-url [expected-project-id]

const base = (process.argv[2] || '').replace(/\/+$/, '');
const expectedProject = process.argv[3] || process.env.FIREBASE_PROJECT_ID || 'sokoflow-whatsapp';

if (!base) {
  console.error('usage: node tools/smoke-deployed.mjs <service-url> [project-id]');
  process.exit(2);
}

const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures.push(name);
}

const healthResponse = await fetch(`${base}/health`);
const healthText = await healthResponse.text();
check('health responds 200', healthResponse.ok, String(healthResponse.status));
check('health has a commerce block', healthText.includes('"commerce"'), healthText.slice(0, 120));
check('commerce is durable (firestore, not memory)', healthText.includes('"durable":true'));
const health = JSON.parse(healthText);
check('production does not seed demo products', health.commerce?.referenceCatalogue === false);
if (process.env.REQUIRE_GEMINI === 'true') {
  check('Gemini server configuration is enabled', health.assistant?.configured === true);
  check('assistant is read-only', health.assistant?.readOnly === true);
}

for (const endpoint of ['/api/onboarding/business/pending', '/api/assistant/chat']) {
  const response = await fetch(`${base}${endpoint}`, endpoint.endsWith('/chat')
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"stock"}' }
    : {});
  check(`${endpoint} rejects unauthenticated access`, response.status === 401, String(response.status));
}

const indexResponse = await fetch(`${base}/`);
const indexHtml = await indexResponse.text();
check('index.html responds 200', indexResponse.ok, String(indexResponse.status));
check('index.html carries no dev HMR shim', !indexHtml.includes('MockWebSocket'));

const bundle = indexHtml.match(/\/assets\/[^"']*\.js/)?.[0];
check('index.html references a bundle', Boolean(bundle), bundle || 'none found');

if (bundle) {
  const js = await (await fetch(`${base}${bundle}`)).text();
  check('bundle is a real build', js.length > 100_000, `${js.length} bytes`);
  check(
    `bundle carries the Firebase project id (${expectedProject})`,
    js.includes(expectedProject),
    'missing means VITE_FIREBASE_* build args did not reach the image',
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}

console.log('\nAll smoke checks passed.');
