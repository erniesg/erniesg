import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'
import type { Principal } from '../principal'
import { ADA, BOB, CHAPTER_ONE, createHarness, proposalBody, scopeQuery, webAnnotation } from './fixtures'
import { principalKey } from './identity'
import { annotationIdFromIri } from './web-annotation'

const SITE = 'https://ernie.sg'
const NOW = '2026-10-08T00:00:00.000Z'
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network is outside this fixture'))))
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture(source = CHAPTER_ONE) {
  const h = createHarness()
  h.database.execute('INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)', [ADA.provider, ADA.issuer, ADA.subject, NOW, NOW])
  const identity = h.database.query('SELECT id FROM margin_identity')[0].id
  h.database.execute("INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(?,'admin',?)", [identity,NOW])
  h.database.execute('INSERT INTO margin_site_admins(site,identity_id) VALUES(?,?)', [SITE,identity])
  const created = await h.request('POST','/annotations',{as:BOB,body:webAnnotation({source,motivation:'editing',visibility:'private'})})
  expect(created.status).toBe(201)
  const row = await created.json(), id = annotationIdFromIri(row.id)
  const action = (name: string) => `/proposals/${id}/${name}${scopeQuery(source)}`
  const call = (method = 'GET', principal: Principal | null = ADA, path = action('review'), database: unknown = h.database) => worker.fetch(new Request('http://localhost/api/margin/v1'+path,{method}), {
    ASSETS:{fetch:async()=>new Response('asset')}, MARGIN_DB:database as typeof h.database,
    MARGIN_ENVIRONMENT:'development', ...(principal ? {MARGIN_DEV_PRINCIPAL:JSON.stringify(principal)} : {}),
  })
  return {h,id,row,source,action,call,item:`/annotations/${id}${scopeQuery(source)}`}
}
const save = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => f.h.request('POST',f.action('review'),{body:{revision:1,decision:'ready',comments:'private review',...extra}})

describe('saved review readback pilots', () => {
  it('reads only with actual global and site authority, including withdrawn/missing distinctions', async () => {
    const f=await fixture()
    expect((await f.h.request('GET',f.action('review'))).status).toBe(200)
    expect((await f.call()).status).toBe(200)
    expect((await f.call('GET',null)).status).toBe(401)
    expect((await f.call('GET',BOB)).status).toBe(403)
    expect((await f.call('GET',ADA,`/proposals/missing/review${scopeQuery(f.source)}`)).status).toBe(404)
    expect((await f.h.request('POST',f.action('withdraw'),{as:BOB})).status).toBe(200)
    expect((await f.call()).status).toBe(200)
    f.h.database.execute('DELETE FROM margin_site_admins')
    expect((await f.call()).status).toBe(403)
  })
  it('returns exact saved metadata while current and approved revisions remain independent', async () => {
    const f=await fixture()
    const first=await f.call();expect(first.status).toBe(200);expect((await first.json()).savedReview).toBeNull()
    expect((await save(f,{comments:''})).status).toBe(200)
    const saved=await (await f.call()).json()
    expect(saved.savedReview).toMatchObject({decision:'ready',comments:'',revision:1,reviewer:principalKey(ADA)})
    expect(saved.savedReview.at).toBeTypeOf('string')
    expect((await f.h.request('POST',f.action('apply'),{body:{revision:1}})).status).toBe(202)
    expect((await f.h.request('PATCH',f.item,{as:BOB,body:{body:proposalBody('A {++later++} draft.')}})).status).toBe(200)
    const later=await (await f.call()).json()
    expect(later.annotation).toMatchObject({'margin:revision':2,'margin:approvedRevision':1,'margin:proposalState':'approved'})
    expect(later.savedReview).toEqual(saved.savedReview)
  })
  it('reports malformed stored review tuples as sanitized503 instead of filling defaults', async () => {
    const f=await fixture()
    f.h.database.execute("UPDATE margin_annotations SET review_decision='ready' WHERE id=?",[f.id])
    const r=await f.call();expect(r.status).toBe(503);expect((await r.json()).error.code).toBe('storage_unavailable')
  })
  it('reconciles a committed Save or Apply after lost response without replaying writes', async () => {
    for (const action of ['review','apply']) {
      const f=await fixture();const query=f.h.database.query.bind(f.h.database);let effects=0
      const spy=vi.spyOn(f.h.database,'query').mockImplementation((sql,params)=>{
        const rows=query(sql,params)
        if (/^(UPDATE margin_annotations SET review_decision|INSERT INTO margin_proposal_applications)/.test(sql)) {effects++;throw new Error('response lost after commit')}
        return rows
      })
      await expect(f.h.request('POST',f.action(action),{body:action==='apply'?{revision:1}:{revision:1,decision:'ready',comments:'durable'}})).rejects.toThrow('response lost')
      const r=await f.call();expect(r.status).toBe(200);const read=await r.json()
      if(action==='apply')expect(read.annotation['margin:approvedRevision']).toBe(1)
      else expect(read.savedReview.comments).toBe('durable')
      expect(effects).toBe(1);spy.mockRestore()
    }
  })
  it('HEAD failures have no body and valid source identity preserves query/fragment', async () => {
    const f=await fixture(SITE+'/books/chapter/?edition=one#passage')
    const available=await f.call('HEAD')
    // A Worker with no binding must also finalize this HEAD failure.
    const missing=await worker.fetch(new Request(SITE+'/api/margin/v1'+f.action('review'),{method:'HEAD'}),{ASSETS:{fetch:async()=>new Response('asset')}})
    expect(missing.status).toBe(503);expect(await missing.text()).toBe('');expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(available.status).toBe(200)
    const r=await f.call();expect(r.status).toBe(200);expect((await r.json()).annotation.target.source).toBe(f.source)
    const head=await f.call('HEAD');expect(head.status).toBe(200);expect(await head.text()).toBe('')
  })
})

it('HEAD finalization follows decoded route spellings on storage failures', async () => {
  const f=await fixture()
  for (const path of [f.action('review'), `/proposals/${encodeURIComponent(f.row.id)}/review/${scopeQuery(f.source)}`,`//%70roposals//${f.id}//%72eview//${scopeQuery(f.source)}`]) {
    for (const database of [null,{prepare(){throw new Error('private failure')}}]) {
      const response=await f.call('HEAD',ADA,path,database)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  }
})

// Execute the real one-statement SQLite read, then alter only the returned D1
// envelope. These controls exercise the production decoder, not a mock grant.
function changedRead(f: Awaited<ReturnType<typeof fixture>>, change: (value: import('./d1').D1Result) => unknown): import('./d1').D1Database {
  const wrap = (statement: import('./d1').D1PreparedStatement, sql: string): import('./d1').D1PreparedStatement => ({
    bind: (...params) => wrap(statement.bind(...params),sql),
    first: statement.first.bind(statement), run: statement.run.bind(statement),
    async all<T>() { const value=await statement.all(); return (sql.includes(' AS review') ? change(value) : value) as import('./d1').D1Result<T> },
  })
  return {prepare:sql=>wrap(f.h.database.prepare(sql),sql)}
}
function changedPayload(change: (value: Record<string,any>)=>void) {
  return (result: import('./d1').D1Result) => {
    const payload=JSON.parse(result.results[0].review as string)
    change(payload)
    return {...result,results:[{...result.results[0],review:JSON.stringify(payload)}]}
  }
}
async function unavailable(f: Awaited<ReturnType<typeof fixture>>, database: unknown, label: string) {
  const response=await f.call('GET',ADA,f.action('review'),database)
  expect(response.status,label).toBe(503)
  expect(await response.json(),label).toEqual({error:{code:'storage_unavailable',message:'the margin store did not answer; check that its migrations are applied'}})
  expect(response.headers.get('cache-control')).toBe('no-store')
}

describe('readback authority and strict persisted state', () => {
  it('uses exactly one read with authority and target in the same snapshot', async () => {
    const f=await fixture();f.h.database.executed.length=0
    expect((await f.call()).status).toBe(200)
    expect(f.h.database.executed).toHaveLength(1)
    expect(f.h.database.executed[0].sql).toMatch(/^SELECT /)
    expect(f.h.database.executed[0].params).toEqual([ADA.provider,ADA.issuer,ADA.subject,SITE,SITE,'/challenges/chapter-1',f.id,ADA.provider,ADA.issuer,ADA.subject])
    const original=f.h.database.query.bind(f.h.database)
    vi.spyOn(f.h.database,'query').mockImplementation((sql,params)=>{
      if(sql.includes(' AS review'))f.h.database.execute('DELETE FROM margin_site_admins')
      return original(sql,params)
    })
    expect((await f.call()).status).toBe(403)
  })
  it.each(['identity','global','mapping','foreign mapping','writer role'])('refuses absent %s authority without bootstrap', async missing => {
    const f=await fixture()
    if(missing==='identity')f.h.database.execute('DELETE FROM margin_identity')
    else if(missing==='global')f.h.database.execute('DELETE FROM margin_allowlist')
    else if(missing==='writer role')f.h.database.execute("UPDATE margin_allowlist SET role='writer'")
    else { f.h.database.execute('DELETE FROM margin_site_admins');if(missing==='foreign mapping')f.h.database.execute("INSERT INTO margin_site_admins SELECT 'https://other.example',id FROM margin_identity") }
    f.h.database.executed.length=0
    expect((await f.call()).status).toBe(403)
    expect(f.h.database.executed).toHaveLength(1)
    expect(f.h.database.executed[0].sql).toMatch(/^SELECT /)
  })
  it('reports absent schemas as unavailable and never bootstraps them on a read', async () => {
    const f=await fixture();const missing=createHarness({identitySchema:false}).database
    await unavailable(f,missing,'identity schema absent')
    expect(missing.executed.every(entry=>entry.sql.startsWith('SELECT '))).toBe(true)
  })
  it('binds provider, issuer and subject rather than display email or creator status', async () => {
    const f=await fixture()
    for(const principal of [BOB,{...ADA,provider:'other'},{...ADA,issuer:'urn:other'},{...ADA,subject:'other',email:'admin@example.test'}]) {
      expect((await f.call('GET',principal)).status).toBe(403)
    }
    expect((await f.call('GET',{...ADA,email:'changed@example.test'})).status).toBe(200)
  })
  it('distinguishes absent and nonproposal targets only after authorization', async () => {
    const f=await fixture()
    const note=await f.h.request('POST','/annotations',{as:BOB,body:webAnnotation({source:f.source,visibility:'private'})})
    const noteId=annotationIdFromIri((await note.json()).id)
    for(const id of ['missing',noteId])for(const principal of [ADA,BOB]) {
      expect((await f.call('GET',principal,`/proposals/${id}/review${scopeQuery(f.source)}`)).status).toBe(principal===ADA?404:403)
    }
    expect((await f.call('GET',ADA,`/proposals/${f.id}/review${scopeQuery(SITE+'/other')}`)).status).toBe(404)
  })
  it('accepts older complete reviews, legacy unsaved data, and approved-without-Save distinctly', async () => {
    const f=await fixture();expect((await save(f)).status).toBe(200)
    const old=(await (await f.call()).json()).savedReview
    expect((await f.h.request('PATCH',f.item,{as:BOB,body:{body:proposalBody('An {++edit++}.')}})).status).toBe(200)
    const updated=await (await f.call()).json();expect(updated.savedReview).toEqual(old);expect(updated.annotation['margin:revision']).toBe(2)
    const unsaved=await fixture();expect((await unsaved.h.request('POST',unsaved.action('apply'),{body:{revision:1}})).status).toBe(202)
    expect(await (await unsaved.call()).json()).toMatchObject({savedReview:null,annotation:{'margin:approvedRevision':1}})
    const legacy=await fixture();legacy.h.database.execute('UPDATE margin_annotations SET base_commit=NULL,source_path=NULL,revision=NULL')
    const read=await legacy.call();expect(read.status).toBe(200);expect((await read.json()).savedReview).toBeNull()
    legacy.h.database.execute('UPDATE margin_annotations SET review_decision=?,review_comments=?,reviewed_revision=?,reviewed_by=?,reviewed_at=?',['ready','',1,principalKey(ADA),NOW])
    await unavailable(legacy,legacy.h.database,'legacy cannot have reviewed revision')
  })
  it('refuses every missing, partial-null and invalid saved metadata field', async () => {
    const f=await fixture();expect((await save(f)).status).toBe(200)
    const invalid:Record<string,unknown[]>={
      review_decision:['',' ready','ready ','x'.repeat(201),false,1,{},[]],
      review_comments:[false,1,{},[], 'x'.repeat(8001)],
      reviewed_revision:[0,-1,1.1,true,'1',Number.MAX_SAFE_INTEGER+1,2],
      reviewed_by:['',false,1,{},'ada','%','dev|urn:margin:dev|ada'],
      reviewed_at:['',false,1,{},'not a date','2026-10-08','2026-13-01T00:00:00Z'],
    }
    for(const [key,values] of Object.entries(invalid)) {
      for(const value of [null,...values])await unavailable(f,changedRead(f,changedPayload(payload=>{payload.saved_review[key]=value})),`${key}:${String(value).slice(0,32)}`)
      await unavailable(f,changedRead(f,changedPayload(payload=>{delete payload.saved_review[key]})),`missing ${key}`)
    }
    for(const value of [undefined,null,[],false,{}, {extra:true}])await unavailable(f,changedRead(f,changedPayload(payload=>{payload.saved_review=value})),'saved tuple shape')
    await unavailable(f,changedRead(f,changedPayload(payload=>{payload.saved_review.extra=true})),'extra metadata')
    await unavailable(f,changedRead(f,changedPayload(payload=>{payload.extra=true})),'extra payload')
  })
  it('refuses malformed D1 envelopes and impossible authority/result combinations', async () => {
    const f=await fixture()
    const changes:((r:import('./d1').D1Result)=>unknown)[]=[
      ()=>null,()=>[],()=>({success:true}),r=>({...r,success:false}),r=>({...r,success:1}),r=>({...r,results:[]}),r=>({...r,results:[...r.results,...r.results]}),
      ...[null,[],{},false,{authorized:1}, {authorized:1,review:12},{authorized:true,review:null},{authorized:'1',review:null},{authorized:2,review:null}].map(row=> (r:import('./d1').D1Result)=>({...r,results:[row]})),
      r=>({...r,results:[{...r.results[0],authorized:0}]}), r=>({...r,results:[{...r.results[0],extra:true}]}),r=>({...r,results:[{...r.results[0],review:'invalid JSON'}]}),
    ]
    for(const [i,change] of changes.entries())await unavailable(f,changedRead(f,change),`D1 shape ${i}`)
  })
  it('refuses all mismatched proposal bindings and impossible revision projections', async () => {
    const f=await fixture();expect((await save(f)).status).toBe(200)
    const changes:((p:Record<string,any>)=>void)[]=[
      ...Object.entries({site:'https://other.example',document:'/other',id:'other',motivation:'commenting',body:'plain text',revision:null,base_commit:null,source_path:null}).map(([key,value])=>(p:Record<string,any>)=>{p.annotation[key]=value}),
      p=>{delete p.annotation.proposal_state},p=>{delete p.annotation.approved_revision},
      p=>{p.annotation.proposal_state='approved'},p=>{p.annotation.approved_revision=1},
      p=>{p.annotation.proposal_state='approved';p.annotation.approved_revision=2},
      p=>{p.annotation.proposal_state='approved';p.annotation.approved_revision=1;p.annotation.withdrawn_at=NOW},
      p=>{p.annotation.proposal_state='approved';p.annotation.approved_revision=1;p.annotation.revision=2;p.saved_review.reviewed_revision=2},
      p=>{p.annotation.review_decision='leak'},
    ]
    for(const [i,change] of changes.entries())await unavailable(f,changedRead(f,changedPayload(change)),`binding ${i}`)
  })
  it('does not mistake later same-revision Save metadata for the earlier uncertain request', async () => {
    const f=await fixture();expect((await save(f,{comments:'first'})).status).toBe(200)
    expect((await save(f,{comments:'second'})).status).toBe(200)
    const before=f.h.database.executed.length
    const read=await f.call();expect(read.status).toBe(200)
    expect((await read.json()).savedReview).toMatchObject({revision:1,comments:'second'})
    expect(f.h.database.executed.slice(before)).toHaveLength(1)
    expect(f.h.database.executed[before].sql).toMatch(/^SELECT /)
    f.h.database.execute('DELETE FROM margin_site_admins')
    expect((await f.call()).status).toBe(403)
    expect(f.h.database.query('SELECT review_comments FROM margin_annotations')[0].review_comments).toBe('second')
  })
  it('rejects ambiguous scope representations and preserves exact document query/fragment identity', async () => {
    const f=await fixture(SITE+'/books/chapter/?edition=one#passage')
    const base=`/proposals/${f.id}/review`
    const query=scopeQuery(f.source)
    for(const suffix of ['&source=','&source='+encodeURIComponent(f.source),'&site=','&document='])expect((await f.call('GET',ADA,base+query+suffix)).status).toBe(400)
    for(const key of ['site','document'])expect((await f.call('GET',ADA,base+'?site='+encodeURIComponent(SITE)+'&document='+encodeURIComponent('/books/chapter/?edition=one#passage')+'&'+key+'=')).status).toBe(400)
    expect((await f.call('GET',ADA,base+'?site='+encodeURIComponent(SITE)+'&document='+encodeURIComponent('/books/chapter/?edition=one#passage'))).status).toBe(200)
    expect((await f.call('GET',ADA,base+scopeQuery(SITE+'/books/chapter/?edition=two#passage'))).status).toBe(404)
    expect((await f.call('GET',ADA,base+scopeQuery(SITE+'/books/chapter/?edition=one#other'))).status).toBe(404)
    const encoded=`/proposals/${encodeURIComponent(f.row.id)}/%72eview/${query}`
    expect((await f.call('GET',ADA,encoded)).status).toBe(200)
  })
  it('HEAD shares every read status and does not add other route methods', async () => {
    const f=await fixture()
    for(const [principal,path,status] of [[null,f.action('review'),401],[BOB,f.action('review'),403],[ADA,`/proposals/missing/review${scopeQuery(f.source)}`,404],[ADA,`/proposals/${f.id}/review`,400],[ADA,f.action('review'),200]] as const) {
      const r=await f.call('HEAD',principal,path);expect(r.status).toBe(status);expect(await r.text()).toBe('');expect(r.headers.get('cache-control')).toBe('no-store')
    }
    const options=await f.call('OPTIONS');expect(options.status).toBe(405);expect(options.headers.get('allow')).toBe('GET, HEAD, POST')
    const apply=await f.call('GET',ADA,f.action('apply'));expect(apply.status).toBe(405);expect(apply.headers.get('allow')).toBe('POST')
  })
  it('keeps saved review metadata out of ordinary response families and readonly operations write nothing', async () => {
    const f=await fixture();expect((await save(f,{comments:'PRIVATE REVIEW SENTINEL'})).status).toBe(200)
    const readback=await (await f.call()).json()
    const values:unknown[]=[readback.annotation]
    for(const path of [f.item,`/annotations${scopeQuery(f.source)}`,`/proposals${scopeQuery(f.source)}`,`/mine?site=${encodeURIComponent(SITE)}&prefix=/challenges/`,`/proposals?scope=review&site=${encodeURIComponent(SITE)}`]) {
      const as=path.includes('scope=review')?ADA:BOB
      const response=await f.h.request('GET',path,{as});expect(response.status,path).toBe(200);values.push(await response.json())
    }
    const changed=await f.h.request('PATCH',f.item,{as:BOB,body:{body:proposalBody('A {++new++} draft.')}});expect(changed.status).toBe(200);values.push(await changed.json())
    const withdrawn=await f.h.request('POST',f.action('withdraw'),{as:BOB});expect(withdrawn.status).toBe(200);values.push(await withdrawn.json())
    for(const value of values) {
      const raw=JSON.stringify(value)
      for(const forbidden of ['savedReview','review_decision','review_comments','reviewed_revision','reviewed_by','reviewed_at','PRIVATE REVIEW SENTINEL'])expect(raw).not.toContain(forbidden)
    }
    f.h.database.executed.length=0;expect((await f.call()).status).toBe(200);expect(f.h.database.executed).toHaveLength(1);expect(f.h.database.executed[0].sql).toMatch(/^SELECT /)
  })
})

it('reads historical reviewer identity and every durable application state without inventing progress', async () => {
  const f=await fixture();expect((await save(f)).status).toBe(200)
  f.h.database.execute('UPDATE margin_annotations SET reviewed_by=?',[principalKey({...ADA,subject:'prior-admin'})])
  expect((await f.h.request('POST',f.action('apply'),{body:{revision:1}})).status).toBe(202)
  for(const state of ['approved','pr_open','conflict','merged','closed','apply_failed']) {
    f.h.database.execute('UPDATE margin_proposal_applications SET state=?',[state])
    const r=await f.call();expect(r.status).toBe(200)
    const data=await r.json();expect(data.annotation['margin:proposalState']).toBe(state)
    expect(data.annotation['margin:approvedRevision']).toBe(1)
    expect(data.savedReview.reviewer).toBe(principalKey({...ADA,subject:'prior-admin'}))
    expect(data).not.toHaveProperty('approvedBody')
  }
})

// Migration0003 retains preexisting editing rows with no source metadata and
// their original free-text body. Two legal fixture updates reproduce exactly
// that persisted shape without disabling insert/update/immutability triggers.
async function legacyFixture(body: string) {
  const f=await fixture()
  f.h.database.execute('UPDATE margin_annotations SET body=? WHERE id=?',[body,f.id])
  f.h.database.execute('UPDATE margin_annotations SET base_commit=NULL,source_path=NULL,revision=NULL WHERE id=?',[f.id])
  expect(f.h.database.query('SELECT base_commit,source_path,revision,review_decision,review_comments,reviewed_revision,reviewed_by,reviewed_at FROM margin_annotations')[0]).toEqual({base_commit:null,source_path:null,revision:null,review_decision:null,review_comments:null,reviewed_revision:null,reviewed_by:null,reviewed_at:null})
  return f
}

describe('READBACK-R1 legacy storage compatibility', () => {
  it.each(['an old free-text proposal','A historical {++inline change++}.','Historical text without a hunk envelope: {'])('keeps an unsaved legacy body readable exactly: %s', async body => {
    const f=await legacyFixture(body)
    for(const path of [f.item,`/proposals${scopeQuery(f.source)}`,`/proposals?scope=review&site=${encodeURIComponent(SITE)}`]) {
      const response=await f.h.request('GET',path,{as:path.includes('scope=review')?ADA:BOB});expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).toContain(body)
    }
    const read=await f.call();expect(read.status).toBe(200)
    const data=await read.json();expect(data.savedReview).toBeNull();expect(data.annotation.body.value).toBe(body)
    for(const key of ['margin:revision','margin:baseCommit','margin:sourcePath','margin:approvedRevision','margin:proposalState'])expect(data.annotation).not.toHaveProperty(key)
    const head=await f.call('HEAD');expect(head.status).toBe(200);expect(await head.text()).toBe('')
    expect((await f.h.request('POST',f.action('withdraw'),{as:BOB})).status).toBe(200)
    const withdrawn=await f.call();expect(withdrawn.status).toBe(200);expect((await withdrawn.json()).annotation.body.value).toBe(body)
  })
  it('keeps legacy rows read-only for admin Save/Apply and retains existing guards', async () => {
    const f=await legacyFixture('Old plain text')
    const before=f.h.database.query('SELECT * FROM margin_annotations')
    for(const action of ['review','apply']) {
      const response=await f.h.request('POST',f.action(action),{body:action==='apply'?{revision:1}:{revision:1,decision:'ready',comments:''}})
      expect(response.status).toBe(409)
    }
    expect(f.h.database.query('SELECT * FROM margin_annotations')).toEqual(before)
    expect(f.h.database.query('SELECT * FROM margin_proposal_applications')).toEqual([])
    const triggers=f.h.database.query("SELECT name FROM sqlite_master WHERE type='trigger'").map(x=>x.name)
    expect(triggers).toContain('margin_annotations_proposal_fields_insert')
    expect(triggers).toContain('margin_annotations_proposal_fields_update')
    const read=await f.call();expect(read.status).toBe(200);expect((await read.json()).savedReview).toBeNull()
  })
  it('refuses saved reviews, application state and partial source stamps on legacy rows', async () => {
    const f=await legacyFixture('Old plain text')
    const fields={review_decision:'ready',review_comments:'',reviewed_revision:1,reviewed_by:principalKey(ADA),reviewed_at:NOW}
    const changes:((p:Record<string,any>)=>void)[]=[
      ...Object.entries(fields).map(([key,value])=>(p:Record<string,any>)=>{p.saved_review[key]=value}),
      p=>{p.saved_review={...fields}},
      p=>{p.annotation.proposal_state='approved';p.annotation.approved_revision=1},
      p=>{p.annotation.base_commit='a'.repeat(40)},p=>{p.annotation.source_path='books/chapter.md'},p=>{p.annotation.revision=1},
    ]
    for(const [i,change] of changes.entries())await unavailable(f,changedRead(f,changedPayload(change)),`legacy impossible ${i}`)
  })
  it.each(['Old plain text','{}','{not JSON'])('still refuses malformed modern stamped body: %s', async body => {
    const f=await fixture();f.h.database.execute('UPDATE margin_annotations SET body=? WHERE id=?',[body,f.id])
    await unavailable(f,f.h.database,'modern malformed body')
    expect((await f.call('HEAD')).status).toBe(503)
  })
})
