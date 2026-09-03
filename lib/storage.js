// Persistence adapter. Locally, JSON files under data/ (easy to back up).
// On Netlify, functions run on an ephemeral filesystem, so data lives in
// Netlify Blobs instead; /tmp is the last-resort fallback there.
const fs = require('fs');
const path = require('path');

const onNetlify = Boolean(
  process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = onNetlify ? '/tmp/crm-data' : path.join(__dirname, '..', 'data');

let blobStorePromise = null;
function blobStore() {
  if (!onNetlify) return null;
  if (!blobStorePromise) {
    // Dynamic import: @netlify/blobs ships as ESM.
    blobStorePromise = import('@netlify/blobs')
      .then(({ getStore }) => getStore('crm-data'))
      .catch(() => null);
  }
  return blobStorePromise;
}

function filePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

async function getJson(key) {
  const store = await blobStore();
  if (store) {
    try { return await store.get(key, { type: 'json' }); } catch {}
  }
  try { return JSON.parse(fs.readFileSync(filePath(key), 'utf8')); } catch { return null; }
}

async function setJson(key, value) {
  const store = await blobStore();
  if (store) {
    try { await store.setJSON(key, value); return; } catch {}
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(key), JSON.stringify(value, null, 2));
}

async function del(key) {
  const store = await blobStore();
  if (store) {
    try { await store.delete(key); } catch {}
  }
  try { fs.unlinkSync(filePath(key)); } catch {}
}

module.exports = { getJson, setJson, del };
