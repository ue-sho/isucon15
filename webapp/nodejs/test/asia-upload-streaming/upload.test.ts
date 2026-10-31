import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import jpeg from 'jpeg-js';
import { application, database, headers, nginx, response } from './harness.ts';
const base = process.env.ASIA_NGINX_BASE ?? '993e1b0dd58d68d7b63e77bff26d046d2a0173b3';
const path = '/api/me/profile-image';
const image = (width = 1, height = 1) => jpeg.encode({ width, height, data: Buffer.alloc(width*height*4, 128) }, 80).data;
// Incremental client respects write()/drain; no fetch buffering masks backpressure.
function upload(url: string, body: Buffer, options: { chunked?: boolean; pauseAfter?: number; pauseMs?: number; headers?: Record<string,string>; method?: string; end?: boolean } = {}) {
  let written = 0, drains = 0, done = false;
  let finish!: (r: { status: number; body: string; ms: number }) => void;
  let fail!: (err: Error) => void;
  const started = performance.now();
  const result = new Promise<{status: number; body: string; ms: number}>((resolve,reject)=>{ finish=resolve; fail=reject; });
  const req = httpRequest(url, { method: options.method ?? 'PUT', headers: { ...headers, 'Content-Type':'image/jpeg',
    ...(!options.chunked ? {'Content-Length':String(body.length)} : {}), ...options.headers } }, res => {
    const parts: Buffer[] = []; res.on('data', b=>parts.push(b));
    res.on('end', ()=>{ done=true; finish({ status: res.statusCode!, body: Buffer.concat(parts).toString(), ms: performance.now()-started }); req.destroy(); });
  });
  req.on('error', err=>{ if(!done) {done=true; fail(err);} });
  req.setTimeout(20_000, ()=>req.destroy(new Error('test client timeout')));
  const pumping = (async ()=>{
    try {
      while (written<body.length && !done && !req.destroyed) {
        const size = Math.min(64*1024, body.length-written, options.pauseAfter && written<options.pauseAfter ? options.pauseAfter-written : Infinity);
        const chunk=body.subarray(written,written+size); written+=size;
        if (!req.write(chunk)) {
          drains++;
          await new Promise<void>(resolve => {
            const ready = () => { req.off('drain', ready); req.off('close', ready); resolve(); };
            req.once('drain', ready); req.once('close', ready);
          });
        }
        if(options.pauseAfter===written) await delay(options.pauseMs ?? 1000);
      }
      if (!done && options.end !== false) req.end();
    } catch(err) { if(!done) req.destroy(err as Error); }
  })();
  return { result, req, pumping, stats:()=>({written,drains}) };
}

test('Asia profile upload: real nginx + current Hono/JPEG + isolated PG16', { skip: process.env.ASIA_UPLOAD_TEST !== '1', timeout: 240_000 }, async t=>{
  const pg = await database(); t.after(pg.close);
  const app = await application(pg.port, 'asia1'); t.after(app.close);
  const before = await nginx(app.port, app.port, true, base); t.after(before.close);
  const after = await nginx(app.port, app.port, false, base); t.after(after.close);
  const valid = image();
  const saved = async ()=> (await pg.db.query('SELECT i.data FROM users u JOIN image_objects i ON i.id=u.profile_image_id WHERE u.id=$1',['owner'])).rows[0]?.data;
  await t.test('normal JPEG exact saved bytes/status/body, Content-Length and chunked', async ()=>{
    for(const edge of [before,after]) for(const chunked of [false,true]) {
      const r=await upload(edge.url+path,valid,{chunked}).result;
      assert.equal(r.status,204); assert.equal(r.body,''); assert.deepEqual(await saved(),valid);
    }
  });
  await t.test('invalid JPEG, dimensions, type, auth, IP ban preserve classification', async ()=>{
    for(const [data,extra,status,error,abuse] of [
      [Buffer.from('not jpeg'),{},400,'invalid_profile_image','invalid_image'],
      [valid.subarray(0,valid.length-3),{},400,'invalid_profile_image','invalid_image'],
      [image(513,1),{},400,'invalid_profile_image',undefined],
      [valid,{'Content-Type':'image/png'},415,'unsupported_media_type',undefined],
      [valid,{Authorization:'Bearer invalid'},401,'invalid_session',undefined],
      [valid,{'X-Client-IP':'203.0.113.99'},403,'ip_banned',undefined],
    ] as const) {
      for(const edge of [before,after]) for(const chunked of [false,true]) {
        const start=app.output().length;
        const r=await upload(edge.url+path,Buffer.from(data),{headers:extra,chunked}).result;
        assert.equal(r.status,status); assert.equal(JSON.parse(r.body).error,error);
        await delay(20);
        const entries=[...app.output().slice(start).matchAll(/\{[^\n]*?\}/g)].map(m=>{try{return JSON.parse(m[0]);}catch{return {};}});
        const log=entries.find(e=>e.action==='put_profile_image' && e.status===status);
        assert.ok(log,app.output().slice(start)); assert.equal(log.abuse,abuse);
      }
    }
  });
  await t.test('32MiB limit remains; non-PUT and similar paths preserve response', async ()=>{
    const tooLarge=Buffer.alloc(32*1024*1024+1,65);
    for(const edge of [before,after]) for(const chunked of [false,true]) {
      const r=await upload(edge.url+path,tooLarge,{chunked}).result;
      assert.equal(r.status,413); assert.deepEqual(await saved(),valid);
    }
    for(const edge of [before,after]) {
      assert.equal((await upload(edge.url+path,tooLarge.subarray(0,32*1024*1024)).result).status,400);
    }
    for(const method of ['GET','HEAD','POST','PATCH','OPTIONS']) {
      assert.deepEqual(await response(after.url+path,{method}),await response(before.url+path,{method}));
    }
    for(const p of [path+'/',path+'/x',path+'-other']) assert.deepEqual(await response(after.url+p,{method:'PUT',body:new Uint8Array(valid)}),await response(before.url+p,{method:'PUT',body:new Uint8Array(valid)}));
    for(const edge of [before,after]) {
      assert.equal((await upload(edge.url+path,valid).result).status,204);
      assert.equal((await response(edge.url+path,{method:'DELETE'})).status,204);
      assert.equal((await response(edge.url+path,{method:'DELETE'})).status,404);
    }
    // No declared body and no chunk framing: treated as empty, not connection-delimited.
    for(const edge of [before,after]) assert.equal((await response(edge.url+path,{method:'PUT',headers:{'Content-Type':'image/jpeg'}})).status,400);
  });
  await t.test('forwarded request metadata and existing Memories/image isolation',async()=>{
    const p=path+'?x=a%2Fb&x=two';
    const a=await response(before.url+p,{method:'PUT',headers:{'X-Test-Probe':'echo'},body:'exact body'});
    const b=await response(after.url+p,{method:'PUT',headers:{'X-Test-Probe':'echo'},body:'exact body'});
    assert.deepEqual(b,a); const value=JSON.parse(b.body);
    assert.equal(value.method,'PUT'); assert.equal(value.url,'http://127.0.0.1'+p); assert.equal(value.body,'exact body');
    assert.equal(value.authorization,headers.Authorization); assert.equal(value.country,'JP'); assert.equal(value.ip,headers['X-Client-IP']);
    assert.equal((await response(after.url+'/_isureal_images/x.jpg')).status,404);
    assert.deepEqual(await response(after.url+'/api/memories?month=2026-10'),await response(before.url+'/api/memories?month=2026-10'));
  });
  await t.test('early refusal and interrupted clients do not persist partial images or retry',async()=>{
    for(const edge of [before,after]) {
      await upload(edge.url+path,valid).result;
      const r=upload(edge.url+path,Buffer.alloc(1024*1024,65),{pauseAfter:1024,pauseMs:300,headers:{Authorization:'Bearer invalid'}});
      assert.equal((await r.result).status,401);
      const partial=upload(edge.url+path,Buffer.alloc(1024*1024,65),{pauseAfter:1024,pauseMs:500});
      await delay(100); partial.req.destroy(new Error('intentional disconnect')); await partial.result.catch(()=>{}); await partial.pumping;
      await delay(100); assert.deepEqual(await saved(),valid);
      const count=(await app.stats()).requests;
      assert.equal((await response(edge.url+path,{method:'PUT',headers:{'X-Test-Probe':'disconnect'},body:new Uint8Array(valid)})).status,502);
      const attempts=(await app.stats()).requests-count;
      if(edge===after) assert.equal(attempts,1);
      t.diagnostic('disconnect='+JSON.stringify({variant:edge===before?'baseline':'streaming',attempts}));
    }
  });
  await t.test('temp files/I/O and RSS: identical 8MiB body, baseline/streaming ABBA',async()=>{
    const large=Buffer.concat([valid,Buffer.alloc(8*1024*1024-valid.length)]);
    const results=[];
    for(const edge of [before,after,after,before]) {
      app.child.send({reset:true}); const n0=await edge.stats(),a0=await app.stats(); const l0=await edge.logs();
      const r=await upload(edge.url+path,large).result;
      assert.equal(r.status,204); assert.deepEqual(await saved(),large);
      const n1=await edge.stats(),a1=await app.stats(),l1=await edge.logs();
      results.push({variant:edge===before?'baseline':'streaming',ms:r.ms,bodyBytes:large.length,
        tempWarnings:l1.error.slice(l0.error.length).split('buffered to a temporary file').length-1,
        nginxWriteBytes:n1.writeBytes-n0.writeBytes,nginxWchar:n1.writeChars-n0.writeChars,nginxRSSKiB:n1.rssKiB,
        nodePeakRSS:a1.maxRSS,nodeRSSDelta:a1.rss-a0.rss,nodeCPUms:((a1.cpu.user-a0.cpu.user)+(a1.cpu.system-a0.cpu.system))/1000});
    }
    t.diagnostic('io=' + JSON.stringify(results));
  });
  await t.test('slow sender versus completed upload and other API responsiveness',async()=>{
    const results=[];
    for(const edge of [before,after]) {
      const slow=upload(edge.url+path,Buffer.concat([valid,Buffer.alloc(1024*1024-valid.length)]),{pauseAfter:1024,pauseMs:1400});
      await delay(250);
      const fast=upload(edge.url+path,valid); const start=performance.now();
      assert.equal((await response(edge.url+'/api/posting-window/current')).status,200);
      const otherMs=performance.now()-start;
      const fastResult=await fast.result; assert.equal(fastResult.status,204); assert.equal((await slow.result).status,204);
      results.push({variant:edge===before?'baseline':'streaming',fastMs:fastResult.ms,otherMs});
    }
    t.diagnostic('slow=' + JSON.stringify(results));
  });
  await t.test('queued uploads: backpressure, RSS and other API with fresh processes',async()=>{
    const large=Buffer.concat([valid,Buffer.alloc(16*1024*1024-valid.length)]);
    const results=[];
    for(const baseline of [true,false]) {
      const worker=await application(pg.port,'queue');
      const edge=await nginx(worker.port,worker.port,baseline,base);
      try {
        const start=await worker.stats();
        const slow=upload(edge.url+path,valid,{pauseAfter:2,pauseMs:2500});
        await delay(200);
        const jobs=Array.from({length:8},()=>upload(edge.url+path,large,{chunked:true}));
        await delay(800); const waiting=await worker.stats(), ng=await edge.stats();
        const clients=jobs.map(j=>j.stats());
        const apiStart=performance.now(); assert.equal((await response(edge.url+'/api/posting-window/current')).status,200);
        const otherMs=performance.now()-apiStart;
        if(!baseline) assert.ok(clients.some(c=>c.written<large.length),'client should be backpressured while decoder slot is held');
        assert.ok(waiting.maxReadableLength<=256*1024,'IncomingMessage buffer must stay bounded');
        const settled=await Promise.all(jobs.map(j=>j.result)); assert.ok(settled.every(r=>r.status===204));
        assert.equal((await slow.result).status,204);
        // The last writer may be the small slow request in buffered mode.
        assert.ok((await saved()).equals(large) || (await saved()).equals(valid));
        results.push({variant:baseline?'baseline':'streaming',requests:8,bodyBytes:large.length,clients,
          nodeRSSBefore:start.rss,nodeRSSWaiting:waiting.rss,nodePeakRSSWaiting:waiting.maxRSS,
          maxReadableLength:waiting.maxReadableLength,nginx:ng,otherMs,uploadMeanMs:settled.reduce((s,r)=>s+r.ms,0)/settled.length});
      } finally {await edge.close();await worker.close();}
    }
    t.diagnostic('queue='+JSON.stringify(results));
  });
  await t.test('client abort while waiting for decoder is 499 and is not saved',async()=>{
    const slow=upload(after.url+path,valid,{pauseAfter:2,pauseMs:1000});
    await delay(200);
    const aborted=upload(after.url+path,image(2,1));
    await delay(100); aborted.req.destroy(new Error('intentional response-wait disconnect'));
    await aborted.result.catch(()=>{}); assert.equal((await slow.result).status,204);
    await delay(100); assert.deepEqual(await saved(),valid);
    assert.match((await after.logs()).access,/PUT \/api\/me\/profile-image 499 /);
  });
  await t.test('idle body timeout (test-only 1s) aborts upstream and releases decoder',async()=>{
    const edge=await nginx(app.port,app.port,false,base,'1s');
    try {
      const stalled=upload(edge.url+path,Buffer.alloc(1024*1024,65),{pauseAfter:1024,pauseMs:1800});
      const result=await stalled.result.catch((err: NodeJS.ErrnoException)=>({status:0,code:err.code}));
      await stalled.pumping;
      assert.match((await edge.logs()).access,/PUT \/api\/me\/profile-image 408 /);
      assert.ok(result.status===408 || ('code' in result && result.code==='ECONNRESET'));
      t.diagnostic('timeout='+JSON.stringify(result));
      assert.equal((await upload(edge.url+path,valid).result).status,204);
    } finally {await edge.close();}
  });
});
