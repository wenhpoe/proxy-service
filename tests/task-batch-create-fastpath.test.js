const test = require('node:test');
const assert = require('node:assert/strict');

const taskSystemPath = require.resolve('../core/taskSystem');
const mysqlPath = require.resolve('../core/mysql');

function loadTaskSystemWithFakeMysql(fakeMysql) {
  delete require.cache[taskSystemPath];
  delete require.cache[mysqlPath];
  require.cache[mysqlPath] = {
    id: mysqlPath,
    filename: mysqlPath,
    loaded: true,
    exports: fakeMysql,
  };
  return require('../core/taskSystem');
}

test.afterEach(() => {
  delete require.cache[taskSystemPath];
  delete require.cache[mysqlPath];
});

test('createClientTaskBatch returns queued batch snapshot without extra task/runs/artifacts readback', async () => {
  const executed = [];
  const fakeConn = {
    async query(sql) {
      executed.push({ kind: 'query', sql });
      if (String(sql).includes('CREATE TABLE')) return [[]];
      if (String(sql).includes('information_schema.COLUMNS')) return [[]];
      return [[]];
    },
    async execute(sql, params = []) {
      executed.push({ kind: 'execute', sql, params });
      if (String(sql).includes('FROM task_batches') && String(sql).includes('idempotency_key')) {
        return [[]];
      }
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  const fakeMysql = {
    isEnabled: () => true,
    execute: async (sql, params = []) => {
      executed.push({ kind: 'pool-execute', sql, params });
      return { affectedRows: 1 };
    },
    withConnection: async (fn) => fn(fakeConn),
    transaction: async (fn) => {
      await fakeConn.beginTransaction();
      try {
        const result = await fn(fakeConn);
        await fakeConn.commit();
        return result;
      } catch (err) {
        await fakeConn.rollback();
        throw err;
      }
    },
  };

  const taskSystem = loadTaskSystemWithFakeMysql(fakeMysql);
  const batch = await taskSystem.createClientTaskBatch({
    machineId: 'machine-a',
    targetMachineId: 'machine-a',
    body: {
      idempotencyKey: 'fastpath-test',
      priority: 50,
      expireAt: new Date(Date.now() + 60_000).toISOString(),
      metadata: { source: 'test' },
      tasks: [
        {
          channel: 'flow',
          provider: '1',
          taskType: 'image',
          prompt: 'hello',
          inputPayload: { channel: 'flow', provider: '1', operation: 'flow.run', params: {} },
        },
      ],
    },
  });

  assert.equal(batch.status, 'queued');
  assert.equal(batch.taskCount, 1);
  assert.equal(batch.tasks[0].status, 'queued');
  assert.equal(Array.isArray(batch.tasks[0].runs), true);
  assert.equal(batch.tasks[0].runs.length, 0);
  assert.equal(Array.isArray(batch.tasks[0].artifacts), true);
  assert.equal(batch.tasks[0].artifacts.length, 0);
  assert.equal(
    executed.some((entry) => String(entry.sql || '').includes('FROM task_runs')),
    false,
    'should not read task_runs during create response fast path',
  );
  assert.equal(
    executed.some((entry) => String(entry.sql || '').includes('FROM task_artifacts')),
    false,
    'should not read task_artifacts during create response fast path',
  );
});

test('createClientTaskBatch allows seedance provider2 without reference asset but still blocks provider1', async () => {
  const fakeConn = {
    async query(sql) {
      if (String(sql).includes('CREATE TABLE')) return [[]];
      if (String(sql).includes('information_schema.COLUMNS')) return [[]];
      return [[]];
    },
    async execute(sql) {
      if (String(sql).includes('FROM task_batches') && String(sql).includes('idempotency_key')) {
        return [[]];
      }
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  const fakeMysql = {
    isEnabled: () => true,
    execute: async () => ({ affectedRows: 1 }),
    withConnection: async (fn) => fn(fakeConn),
    transaction: async (fn) => {
      await fakeConn.beginTransaction();
      try {
        const result = await fn(fakeConn);
        await fakeConn.commit();
        return result;
      } catch (err) {
        await fakeConn.rollback();
        throw err;
      }
    },
  };

  const taskSystem = loadTaskSystemWithFakeMysql(fakeMysql);
  const channelCatalog = {
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '2',
        constraints: { requires_image: true },
        providers: [
          {
            key: '1',
            label: '服务商 1',
            enabled: true,
            constraints: { requires_image: true },
          },
          {
            key: '2',
            label: '服务商 2',
            enabled: true,
            constraints: { requires_image: false },
          },
        ],
      },
    ],
  };

  const provider2Batch = await taskSystem.createClientTaskBatch({
    machineId: 'machine-a',
    targetMachineId: 'machine-a',
    channelCatalog,
    body: {
      idempotencyKey: 'seedance-provider2-no-ref',
      priority: 50,
      expireAt: new Date(Date.now() + 60_000).toISOString(),
      tasks: [
        {
          channel: 'seedance',
          provider: '2',
          taskType: 'video',
          prompt: 'text to video',
          inputPayload: {
            channel: 'seedance',
            provider: '2',
            operation: 'video.generate',
            params: { prompt: 'text to video' },
          },
        },
      ],
    },
  });

  assert.equal(provider2Batch.status, 'queued');
  assert.equal(provider2Batch.tasks[0].taskType, 'video');

  await assert.rejects(
    () => taskSystem.createClientTaskBatch({
      machineId: 'machine-a',
      targetMachineId: 'machine-a',
      channelCatalog,
      body: {
        idempotencyKey: 'seedance-provider1-no-ref',
        priority: 50,
        expireAt: new Date(Date.now() + 60_000).toISOString(),
        tasks: [
          {
            channel: 'seedance',
            provider: '1',
            taskType: 'video',
            prompt: 'image to video',
            inputPayload: {
              channel: 'seedance',
              provider: '1',
              operation: 'video.generate',
              params: { prompt: 'image to video' },
            },
          },
        ],
      },
    }),
    /seedance requires referenceAssetId/,
  );
});
