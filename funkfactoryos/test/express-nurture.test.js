const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const expressNurturePath = path.resolve(__dirname, '../db/express-nurture.js');
const fakePool = { query: null };
const originalLoad = Module._load;

Module._load = function load(request, parent, isMain) {
  if (request === './index' && parent && parent.filename === expressNurturePath) {
    return fakePool;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { windowStats } = require('../db/express-nurture');
Module._load = originalLoad;

test('windowStats uses a legal CTE name and preserves query parameters', async () => {
  const expectedStats = {
    total_in_window: 4,
    already_converted: 1,
    already_sent: 1,
    candidates: 2
  };
  let capturedQuery;

  fakePool.query = async (sql, parameters) => {
    capturedQuery = { sql, parameters };
    return { rows: [expectedStats] };
  };

  try {
    const result = await windowStats(3);

    assert.deepEqual(result, expectedStats);
    assert.deepEqual(capturedQuery.parameters, [3, 2]);
    assert.match(capturedQuery.sql, /WITH contact_window AS \(/);
    assert.equal(capturedQuery.sql.includes('FROM contact_window'), true);
    assert.equal(capturedQuery.sql.includes('FROM window'), false);
  } finally {
    fakePool.query = null;
  }
});
