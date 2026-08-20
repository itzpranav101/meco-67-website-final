const env = (name, fallback = '') => process.env[name] || fallback;
const endpoint = env('APPWRITE_ENDPOINT', 'https://sgp.cloud.appwrite.io/v1').replace(/\/$/, '');
const projectId = env('APPWRITE_PROJECT_ID');
const databaseId = env('APPWRITE_DATABASE_ID');
const tableId = env('APPWRITE_TABLE_ID', 'meco_records');
const tableName = env('APPWRITE_TABLE_NAME', 'Meco records');
const apiKey = env('APPWRITE_API_KEY');

if (!projectId || !databaseId || !apiKey) {
  throw new Error('APPWRITE_PROJECT_ID, APPWRITE_DATABASE_ID and APPWRITE_API_KEY are required.');
}

const request = async (method, route, body) => {
  const response = await fetch(`${endpoint}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Appwrite-Project': projectId, 'X-Appwrite-Key': apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { ok: response.ok, status: response.status, data };
};

const database = await request('GET', `/tablesdb/${encodeURIComponent(databaseId)}`);
if (!database.ok) throw new Error(`Database ${databaseId} is unavailable: ${database.data.message || database.status}`);
console.log(`Database ready: ${databaseId}`);

const route = `/tablesdb/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(tableId)}`;
const existing = await request('GET', route);
if (existing.ok) {
  console.log(`Table already exists: ${tableId}`);
  const columns = Array.isArray(existing.data.columns) ? existing.data.columns : [];
  const required = [
    ['owner_id', 128],
    ['entity', 64],
    ['payload', 18000],
    ['created_date', 64],
    ['updated_date', 64],
  ];
  const missing = required.filter(([key, minimum]) => {
    const column = columns.find((item) => item.key === key);
    return !column || (Number(column.size || minimum) < minimum);
  });
  if (missing.length) {
    throw new Error(`Existing table is missing required columns or sizes: ${missing.map(([key]) => key).join(', ')}`);
  }
  const payload = columns.find((item) => item.key === 'payload');
  if (payload && payload.encrypt !== true) console.warn('Warning: payload exists but is not marked encrypted. Enable encryption in Appwrite Console for stronger at-rest protection.');
  console.log('Table schema is compatible with Meco chunked state storage.');
  process.exit(0);
}
if (existing.status !== 404) throw new Error(existing.data.message || `Table lookup failed (${existing.status}).`);

const created = await request('POST', `/tablesdb/${encodeURIComponent(databaseId)}/tables`, {
  tableId,
  name: tableName,
  permissions: [],
  rowSecurity: false,
  enabled: true,
  columns: [
    { key: 'owner_id', type: 'string', size: 128, required: true },
    { key: 'entity', type: 'string', size: 64, required: true },
    { key: 'payload', type: 'string', size: 20000, required: true, encrypt: true },
    { key: 'created_date', type: 'string', size: 64, required: true },
    { key: 'updated_date', type: 'string', size: 64, required: true }
  ],
  indexes: [{ key: 'owner_entity', type: 'key', attributes: ['owner_id', 'entity'], orders: ['ASC', 'ASC'] }]
});
if (!created.ok) throw new Error(created.data.message || `Table creation failed (${created.status}).`);
console.log(`Created private Appwrite table: ${tableId}`);
