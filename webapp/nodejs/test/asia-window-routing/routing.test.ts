import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import jpeg from 'jpeg-js';
import { application, database, headers, nginx, response } from './harness.ts';

const base = process.env.ASIA_NGINX_BASE ?? '993e1b0dd58d68d7b63e77bff26d046d2a0173b3';
const path = '/api/posting-window/current';
test('Asia current posting window: real nginx + current Hono + isolated PG16', { skip: process.env.ASIA_WINDOW_TEST !== '1', timeout: 180_000 }, async t => {
  const pg = await database(); t.after(pg.close);
  const local = await application(pg.port, 'asia1'); t.after(local.close);
  const near = await application(pg.port, 'asia2'); t.after(near.close);
  const before = await nginx(local.port, near.port, true, base); t.after(before.close);
  const after = await nginx(local.port, near.port, false, base); t.after(after.close);
  const pair = async (p = path, init: RequestInit = {}) => {
    const a = await response(before.url + p, init), b = await response(after.url + p, init);
    assert.deepEqual(b, a); return b;
  };
  await t.test('only exact GET; URI/query/auth/country/IP/Host and other routes survive', async () => {
    for (const [p, method, expected] of [
      [path + '?x=a%2Fb&x=two', 'GET', 'asia2'], [path, 'HEAD', 'asia1'], [path, 'POST', 'asia1'],
      [path, 'OPTIONS', 'asia1'], [path, 'PUT', 'asia1'], [path, 'DELETE', 'asia1'], [path, 'PATCH', 'asia1'],
      [path + '/', 'GET', 'asia1'], [path + '/x', 'GET', 'asia1'], [path + '-other', 'GET', 'asia1'],
      ['/api/posts', 'POST', 'asia1'], ['/api/admin/posting-window', 'POST', 'asia1'], ['/api/me', 'GET', 'asia1'],
      ['/api/notifications', 'GET', 'asia1'], ['/api/images/example', 'GET', 'asia1'],
      ['/api/memories?month=2026-10', 'GET', 'asia2'], ['/api/memories/2026-10-10', 'GET', 'asia2'],
    ]) {
      const oldLocal = (await local.stats()).requests, oldNear = (await near.stats()).requests;
      const r = await response(after.url + p, { method, headers: { 'X-Test-Probe': 'echo' }, ...(method === 'POST' ? { body: 'body=kept' } : {}) });
      assert.equal(r.status, 200);
      assert.equal((await local.stats()).requests - oldLocal, expected === 'asia1' ? 1 : 0, `${method} ${p}`);
      assert.equal((await near.stats()).requests - oldNear, expected === 'asia2' ? 1 : 0, `${method} ${p}`);
      if (method !== 'HEAD') {
        const body = JSON.parse(r.body);
        assert.equal(body.instance, expected); assert.equal(body.method, method);
        assert.equal(body.url, 'http://127.0.0.1' + p); assert.equal(body.authorization, headers.Authorization);
        assert.equal(body.country, 'JP'); assert.equal(body.ip, headers['X-Client-IP']);
        if (method === 'POST') assert.equal(body.body, 'body=kept');
      }
    }
    for (const p of [path + '/', path + '/x', path + '-other']) assert.equal((await pair(p)).status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) await pair(path, { method });
    assert.equal((await response(after.url + '/_isureal_images/example.jpg')).status, 404);
  });
  await t.test('invalid/revoked session, region mismatch, IP ban match local status/body', async () => {
    for (const [extra, status, error] of [
      [{ Authorization: 'Bearer invalid' }, 401, 'invalid_session'],
      [{ Authorization: 'wrong' }, 401, 'invalid_session'],
      [{ Authorization: 'Bearer europe' }, 403, 'region_mismatch'],
      [{ 'X-Client-IP': '203.0.113.99' }, 403, 'ip_banned'],
    ] as const) {
      const r = await pair(path, { headers: extra }); assert.equal(r.status, status);
      assert.equal(JSON.parse(r.body).error, error);
    }
    await pg.db.query("UPDATE login_sessions SET active=false WHERE id='owner'");
    assert.equal((await pair()).status, 401);
    await pg.db.query("UPDATE login_sessions SET active=true WHERE id='owner'");
  });
  await t.test('no period, pre-start/post-start, active post and 0/1/2 deletions', async () => {
    assert.deepEqual(JSON.parse((await pair()).body), { window: null, hasPosted: false, canPost: false, deletionCount: 0 });
    await pg.db.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
      VALUES('current','asia','2026-10-31',clock_timestamp()+interval '1 second',clock_timestamp()+interval '2 minutes')`);
    assert.equal(JSON.parse((await pair()).body).canPost, false);
    await delay(1100);
    assert.equal(JSON.parse((await pair()).body).canPost, true);
    await pg.db.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
      VALUES('current-post','owner','current','image','friends','none',clock_timestamp())`);
    let r = JSON.parse((await pair()).body); assert.equal(r.hasPosted, true); assert.equal(r.canPost, false);
    await pg.db.query("UPDATE posts SET deleted_at=clock_timestamp() WHERE id='current-post'");
    r = JSON.parse((await pair()).body); assert.equal(r.deletionCount, 1); assert.equal(r.canPost, true);
    await pg.db.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at,deleted_at)
      VALUES('deleted-post','owner','current','image','friends','none',clock_timestamp(),clock_timestamp())`);
    r = JSON.parse((await pair()).body); assert.equal(r.deletionCount, 2); assert.equal(r.canPost, false);
  });
  await t.test('period switch is visible on commit, no stale routing response', async () => {
    await pg.db.query('BEGIN');
    try {
      await pg.db.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id='current'");
      await pg.db.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
        VALUES('next','asia','2026-11-01',clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 minutes')`);
      assert.equal(JSON.parse((await pair()).body).window.id, 'current');
      await pg.db.query('COMMIT');
    } catch (err) { await pg.db.query('ROLLBACK'); throw err; }
    const r = JSON.parse((await pair()).body); assert.equal(r.window.id, 'next'); assert.equal(r.canPost, true); assert.equal(r.deletionCount, 0);
  });
  await t.test('real Memories and current GET concurrently (ABBA, pool=2 per process)', async () => {
    const image = jpeg.encode({ data: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 }, 80).data;
    await pg.db.query("INSERT INTO image_objects(id,owner_user_id,data,media_type) VALUES('image','owner',$1,'image/jpeg')", [image]);
    await pg.db.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
      SELECT 'history-'||n,'owner','current','history-image-'||n,'friends','none','2026-10-31T12:00:00Z'::timestamptz - n*interval '1 second' FROM generate_series(1,50)n`);
    await pg.db.query(`INSERT INTO image_objects(id,owner_user_id,data,media_type)
      SELECT 'history-image-'||n,'owner',$1,'image/jpeg' FROM generate_series(1,50)n`,[image]);
    const results = [];
    for (const edge of [before, after, after, before]) {
      await response(edge.url + path); await response(edge.url + '/api/memories?month=2026-10');
      local.child.send({ reset: true }); near.child.send({ reset: true });
      const begin = [await local.stats(), await near.stats()];
      const timings: Record<string, number[]> = { window: [], memories: [] };
      await Promise.all(Array.from({ length: 4 }, async (_, client) => {
        const kind = client % 2 ? 'memories' : 'window';
        const p = kind === 'window' ? path : '/api/memories?month=2026-10';
        for (let i = 0; i < 10; i++) {
          const start = performance.now(); const r = await response(edge.url + p);
          timings[kind]!.push(performance.now()-start); assert.equal(r.status, 200);
          if (kind === 'memories') assert.equal(JSON.parse(r.body).items.length, 50);
        }
      }));
      const end = [await local.stats(), await near.stats()];
      const summary = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, {
        n: values.length, meanMs: values.reduce((a,b)=>a+b,0)/values.length, p95Ms: values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1],
      }]));
      results.push({ variant: edge === before ? 'baseline' : 'routing', ...summary, resources: end.map((s,i)=>({ maxRSS: s.maxRSS, cpuMs: ((s.cpu.user-begin[i].cpu.user)+(s.cpu.system-begin[i].cpu.system))/1000 })) });
    }
    t.diagnostic('concurrent=' + JSON.stringify(results));
  });
  await t.test('upstream reset is not retried; stopped asia2 gives 502 and does not fall back', async () => {
    const b = await near.stats();
    assert.equal((await response(after.url + path, { headers: { 'X-Test-Probe': 'disconnect' } })).status, 502);
    assert.equal((await near.stats()).requests-b.requests, 1);
    await near.close();
    const localBefore = await local.stats();
    assert.equal((await response(after.url + path)).status, 502);
    assert.equal((await local.stats()).requests, localBefore.requests);
    assert.equal((await response(before.url + path)).status, 200);
    assert.equal((await response(after.url + path, { method: 'POST' })).status, 405);
    const log = await after.logs();
    assert.ok(log.access.split('\n').filter(l=>l.startsWith('GET '+path+' 502 ')).every(l=>!l.includes(', ')));
  });
});
