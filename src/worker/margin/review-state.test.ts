import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADA, BOB, CHAPTER_ONE, createHarness, proposalBody, scopeQuery, webAnnotation, type MarginHarness } from './fixtures'
import { ensureSchema } from './identity'
import { annotationIdFromIri } from './web-annotation'
import worker from '../index'
import type { D1Database, D1PreparedStatement, D1Result } from './d1'
import { handleMarginRequest } from './routes'
import type { TenantScope } from './repository'
import { principalKey } from './identity'

const SITE = 'https://ernie.sg'
const NOW = '2026-10-07T00:00:00.000Z'
beforeEach(() => vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('network is outside this fixture'))))
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture(visibility: 'private' | 'public' = 'public') {
  const h = createHarness()
  await ensureSchema(h.database)
  h.database.execute('INSERT INTO margin_identity(provider,issuer,subject,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)', [ADA.provider, ADA.issuer, ADA.subject, NOW, NOW])
  h.database.execute("INSERT INTO margin_allowlist(identity_id,role,added_at) VALUES(1,'admin',?)", [NOW])
  h.database.execute('INSERT INTO margin_site_admins(site,identity_id) VALUES(?,1)', [SITE])
  const created = await h.request('POST', '/annotations', { as: BOB, body: webAnnotation({ source: CHAPTER_ONE, motivation: 'editing', visibility }) })
  expect(created.status).toBe(201)
  const row = await created.json()
  const id = annotationIdFromIri(row.id)
  return { h, id, row, action: (name: string) => `/proposals/${id}/${name}${scopeQuery(CHAPTER_ONE)}`, item: `/annotations/${id}${scopeQuery(CHAPTER_ONE)}` }
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, revision = 1) {
  return f.h.request('POST', f.action('apply'), { body: { revision } })
}
function snapshot(h: MarginHarness) { return h.database.query('SELECT * FROM margin_proposal_applications') }

describe('durable proposal review pilots', () => {
  it('real SQLite all returns one conditional UPDATE or INSERT SELECT result and zero on CAS miss', async () => {
    const h = createHarness()
    h.database.execute('CREATE TABLE returning_probe(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)')
    h.database.execute('INSERT INTO returning_probe VALUES(1,1)')
    const saved = await h.database.prepare('UPDATE returning_probe SET revision=revision+1 WHERE id=? AND revision=? RETURNING id,revision').bind(1,1).all()
    expect(saved).toEqual({ success: true, results: [{ id: 1, revision: 2 }] })
    const approved = await h.database.prepare('INSERT INTO returning_probe SELECT 2,revision FROM returning_probe WHERE id=1 AND revision=? RETURNING id,revision').bind(2).all()
    expect(approved).toEqual({ success: true, results: [{ id: 2, revision: 2 }] })
    expect((await h.database.prepare('UPDATE returning_probe SET revision=3 WHERE id=1 AND revision=1 RETURNING id').all()).results).toEqual([])
  })

  it('admin/site authority applies to both Save and Apply', async () => {
    const f = await fixture('private')
    for (const action of ['review', 'apply']) {
      const body = action === 'review' ? { revision: 1, decision: 'revise', comments: 'clarify' } : { revision: 1 }
      expect((await f.h.request('POST', f.action(action), { as: null, body })).status).toBe(401)
      expect((await f.h.request('POST', f.action(action), { as: BOB, body })).status).toBe(403)
    }
  })

  it('Save keeps pending and Apply atomically binds its exact revision', async () => {
    const f = await fixture('private')
    const save = await f.h.request('POST', f.action('review'), { body: { revision: 1, decision: 'ready', comments: 'reviewed', body: proposalBody('Changed {++text++}.') } })
    expect(save.status).toBe(200)
    expect((await save.json())['margin:revision']).toBe(2)
    expect(snapshot(f.h)).toEqual([])
    expect((await approve(f)).status).toBe(409)
    const applied = await approve(f, 2)
    expect(applied.status).toBe(202)
    expect(await applied.json()).toMatchObject({ state: 'approved', approvedRevision: 2 })
    expect(snapshot(f.h)).toHaveLength(1)
  })

  it('creator revision after approval changes only current content; second Apply and admin Save refuse', async () => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    const before = snapshot(f.h)
    const patch = await f.h.request('PATCH', f.item, { as: BOB, body: { body: proposalBody('A {++later++} draft.'), 'margin:baseCommit': 'b'.repeat(40) } })
    expect(patch.status).toBe(200)
    expect(await patch.json()).toMatchObject({ 'margin:revision': 2, 'margin:proposalState': 'approved' })
    expect(snapshot(f.h)).toEqual(before)
    expect((await approve(f, 2)).status).toBe(409)
    expect((await f.h.request('POST', f.action('review'), { body: { revision: 2, decision: 'ready', comments: '' } })).status).toBe(409)
  })

  it('approval prevents withdraw/delete and all snapshot updates or removal', async () => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    for (const [method,path] of [['POST',f.action('withdraw')],['DELETE',f.item]]) {
      const result = await f.h.request(method,path,{ as: BOB })
      expect(result.status).toBe(409)
      expect((await result.json()).error.code).toBe('proposal_approved')
    }
    expect(() => f.h.database.execute("UPDATE margin_proposal_applications SET body='changed'")).toThrow()
    expect(() => f.h.database.execute('DELETE FROM margin_proposal_applications')).toThrow()
    expect(snapshot(f.h)).toHaveLength(1)
  })

  it('nonpending state is projected only to creator and the proposal site admin including mine', async () => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    for (const principal of [ADA, BOB, null, { ...BOB, subject: 'other' }]) {
      const response = await f.h.request('GET', f.item, { as: principal })
      expect(response.status).toBe(200)
      expect((await response.json())['margin:proposalState']).toBe(principal === ADA || principal === BOB ? 'approved' : undefined)
    }
    const mine = await f.h.request('GET','/mine?site=https%3A%2F%2Fernie.sg&prefix=%2F',{as:BOB})
    expect((await mine.json()).annotations[0]['margin:proposalState']).toBe('approved')
    const review = await f.h.request('GET','/proposals?scope=review&state=approved')
    expect(review.status).toBe(200)
    expect((await review.json()).annotations[0]['margin:approvedRevision']).toBe(1)
  })
})

describe('review mutation boundary and snapshot lifecycle', () => {
  it.each(['review','apply'])('%s rechecks revision, withdrawal and current authority inside its write', async action => {
    for (const race of ['revision','withdrawal','mapping','role']) {
      const f = await fixture()
      const query = f.h.database.query.bind(f.h.database)
      let crossed = false
      vi.spyOn(f.h.database,'query').mockImplementation((sql,params) => {
        if (!crossed && /^(INSERT INTO margin_proposal_applications|UPDATE margin_annotations SET review_decision)/.test(sql)) {
          crossed = true
          if (race === 'revision') f.h.database.execute('UPDATE margin_annotations SET revision=revision+1 WHERE id=?',[f.id])
          if (race === 'withdrawal') f.h.database.execute('UPDATE margin_annotations SET withdrawn_at=? WHERE id=?',[NOW,f.id])
          if (race === 'mapping') f.h.database.execute('DELETE FROM margin_site_admins')
          if (race === 'role') f.h.database.execute("UPDATE margin_allowlist SET role='writer'")
        }
        return query(sql,params)
      })
      const response = await f.h.request('POST',f.action(action), {body: action === 'apply' ? {revision:1} : {revision:1,decision:'ready',comments:''}})
      expect(crossed).toBe(true)
      expect(response.status,race).toBe(race === 'mapping' || race === 'role' ? 403 : 409)
      expect(snapshot(f.h)).toEqual([])
      expect(f.h.database.query('SELECT review_decision FROM margin_annotations')[0].review_decision).toBeNull()
    }
  })

  it.each(['review','apply'])('%s result loss after commit is unknown and never silently replayed', async action => {
    const f = await fixture()
    const query = f.h.database.query.bind(f.h.database)
    let effects = 0
    const spy = vi.spyOn(f.h.database,'query').mockImplementation((sql,params) => {
      const rows = query(sql,params)
      if (/^(INSERT INTO margin_proposal_applications|UPDATE margin_annotations SET review_decision)/.test(sql)) {
        effects++
        throw new Error('fixture response lost after commit')
      }
      return rows
    })
    const body = action === 'apply' ? {revision:1} : {revision:1,decision:'ready',comments:'saved',body:proposalBody('New {++body++}.')}
    await expect(f.h.request('POST',f.action(action),{body})).rejects.toThrow('response lost')
    expect(effects).toBe(1)
    spy.mockRestore()
    expect((await f.h.request('POST',f.action(action),{body})).status).toBe(409)
    if (action === 'apply') expect(snapshot(f.h)).toHaveLength(1)
    else expect(f.h.database.query('SELECT revision,review_comments FROM margin_annotations')[0]).toEqual({revision:2,review_comments:'saved'})
  })

  it.each(['body','baseCommit','visibility'])('approved creator PATCH of %s preserves snapshot and state', async field => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    const original = snapshot(f.h)
    const body = field === 'body' ? {body:proposalBody('A {++new++} draft.')} : field === 'baseCommit' ? {'margin:baseCommit':'c'.repeat(40)} : {'margin:visibility':'private'}
    const result = await f.h.request('PATCH',f.item,{as:BOB,body})
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({'margin:proposalState':'approved','margin:revision':field === 'visibility' ? 1 : 2})
    expect(snapshot(f.h)).toEqual(original)
    expect((await f.h.request('PATCH',f.item,{as:BOB,body:{'margin:sourcePath':'other.md'}})).status).toBe(400)
    expect((await f.h.request('PATCH',f.item,{as:BOB,body:{'margin:proposalState':'pending'}})).status).toBe(400)
  })

  it.each(['withdraw','delete'])('approval racing %s yields approval-specific 409 without removing state', async action => {
    const f = await fixture()
    const name = action === 'withdraw' ? 'withdrawProposal' : 'deleteAnnotation'
    const old = f.h.repository[name].bind(f.h.repository)
    vi.spyOn(f.h.repository,name).mockImplementation(async (scope: TenantScope, id: string, owner: string, at?: string) => {
      expect((await approve(f)).status).toBe(202)
      return old(scope, id, owner, at!)
    })
    const response = await f.h.request(action === 'withdraw' ? 'POST' : 'DELETE', action === 'withdraw' ? f.action('withdraw') : f.item,{as:BOB})
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('proposal_approved')
    expect(snapshot(f.h)).toHaveLength(1)
  })

  it('every snapshot column, replacement and deletion are guarded while current creator content is mutable', async () => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    const before = snapshot(f.h)
    for (const key of Object.keys(before[0]).filter(key => key !== 'state')) {
      expect(() => f.h.database.execute(`UPDATE margin_proposal_applications SET ${key}=${key}`),key).toThrow('immutable')
    }
    expect(() => f.h.database.execute('INSERT OR REPLACE INTO margin_proposal_applications SELECT * FROM margin_proposal_applications')).toThrow('replaced')
    expect(() => f.h.database.execute('DELETE FROM margin_annotations WHERE id=?',[f.id])).toThrow(/FOREIGN KEY/)
    expect(snapshot(f.h)).toEqual(before)
  })

  it('legacy incomplete metadata cannot be approved and nonproposal review never mutates', async () => {
    const f = await fixture()
    f.h.database.execute('UPDATE margin_annotations SET base_commit=NULL,source_path=NULL,revision=NULL')
    expect((await approve(f)).status).toBe(409)
    expect(snapshot(f.h)).toEqual([])
    const note = await f.h.request('POST','/annotations',{body:webAnnotation({source:CHAPTER_ONE})})
    const id = annotationIdFromIri((await note.json()).id)
    expect((await f.h.request('POST',`/proposals/${id}/apply${scopeQuery(CHAPTER_ONE)}`,{body:{revision:1}})).status).toBe(404)
  })
})

describe('state projection and pagination', () => {
  it.each(['approved','pr_open','conflict','merged','closed','apply_failed'])('%s stays viewer scoped in single, collection and mine responses', async state => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    f.h.database.execute('UPDATE margin_proposal_applications SET state=?',[state])
    for (const [who,allowed] of [[BOB,true],[ADA,true],[null,false],[{...BOB,subject:'unrelated'},false]] as const) {
      for (const path of [f.item,`/annotations${scopeQuery(CHAPTER_ONE)}`]) {
        const response = await f.h.request('GET',path,{as:who})
        expect(response.status).toBe(200)
        const value = await response.json()
        const row = value.annotations ? value.annotations[0] : value
        expect(row['margin:proposalState']).toBe(allowed ? state : undefined)
        expect(row['margin:approvedRevision']).toBeUndefined()
        for (const key of ['review_comments','reviewed_by','approved_by','approved_body']) expect(row).not.toHaveProperty(key)
      }
    }
    f.h.database.execute('UPDATE margin_site_admins SET site=?',['https://elsewhere.example'])
    const foreign = await f.h.request('GET',f.item)
    expect((await foreign.json())['margin:proposalState']).toBeUndefined()
    expect((await f.h.request('GET',`/proposals${scopeQuery(CHAPTER_ONE)}`,{as:BOB})).status).toBe(200)
    expect((await (await f.h.request('GET',`/proposals${scopeQuery(CHAPTER_ONE)}`,{as:BOB})).json()).annotations).toEqual([])
  })

  it('review pagination binds state and keeps current revision separate from approved revision', async () => {
    const f = await fixture()
    expect((await approve(f)).status).toBe(202)
    await f.h.request('PATCH',f.item,{as:BOB,body:{body:proposalBody('A {++later++} version.')}})
    const row = await f.h.request('POST','/annotations',{as:BOB,body:webAnnotation({source:CHAPTER_ONE,motivation:'editing'})})
    const id = annotationIdFromIri((await row.json()).id)
    expect((await f.h.request('POST',`/proposals/${id}/apply${scopeQuery(CHAPTER_ONE)}`,{body:{revision:1}})).status).toBe(202)
    const path = '/proposals?scope=review&state=approved&limit=1'
    const page = await (await f.h.request('GET',path)).json()
    expect(page.annotations[0]).toMatchObject({'margin:revision':2,'margin:approvedRevision':1,'margin:proposalState':'approved'})
    expect((await f.h.request('GET',path+'&cursor='+encodeURIComponent(page.nextCursor))).status).toBe(200)
    expect((await f.h.request('GET',path.replace('approved','pending')+'&cursor='+encodeURIComponent(page.nextCursor))).status).toBe(400)
  })

  it('ordinary anonymous reads need no identity schema; authenticated admin projection cannot silently skip missing authority', async () => {
    const h = createHarness({identitySchema:false})
    const created = await h.request('POST','/annotations',{as:BOB,body:webAnnotation({source:CHAPTER_ONE,motivation:'editing',visibility:'public'})})
    const id = annotationIdFromIri((await created.json()).id)
    const item = `/annotations/${id}${scopeQuery(CHAPTER_ONE)}`
    expect((await h.request('GET',item,{as:null})).status).toBe(200)
    await expect(h.request('GET',item,{as:ADA})).rejects.toThrow(/no such table/)
    // Creator-only mine and writes do not need an admin authority lookup.
    expect((await h.request('GET','/mine?site=https%3A%2F%2Fernie.sg&prefix=%2F',{as:BOB})).status).toBe(200)
    expect(h.database.query("SELECT name FROM sqlite_master WHERE name='margin_identity'")).toEqual([])
  })
})


function wrappedDatabase(h: MarginHarness, match: (sql: string) => boolean, change: (value: D1Result) => unknown): D1Database {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...params) => wrap(statement.bind(...params), sql),
    first: statement.first.bind(statement), run: statement.run.bind(statement),
    async all<T>() {
      const result = await statement.all()
      return (match(sql) ? change(result) : result) as D1Result<T>
    },
  })
  return {prepare:sql => wrap(h.database.prepare(sql),sql)}
}
async function workerCall(database: D1Database, path: string, body?: unknown, as = ADA) {
  return worker.fetch(new Request('http://localhost/api/margin/v1'+path, {
    method:body === undefined ? 'GET' : 'POST', headers:{'content-type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }),{ASSETS:{fetch:async () => new Response(null,{status:404})},MARGIN_DB:database,
    MARGIN_ENVIRONMENT:'development',MARGIN_DEV_PRINCIPAL:JSON.stringify(as)})
}

describe('strict durable write results and response families', () => {
  it.each(['apply','review'])('%s never reports success for malformed or lost postcommit results', async action => {
    const mutations: [string,(result:D1Result)=>unknown][] = [
      ['false',result=>({...result,success:false})],
      ['missing results',()=>({success:true})],
      ['duplicate',result=>({...result,results:[...result.results,...result.results]})],
      ['null row',result=>({...result,results:[null]})],
      ...['revision','body','site','creator'].map(key=>[key,(result:D1Result)=>({...result,results:result.results.map(row=>({...row,[key]:false}))})] as [string,(result:D1Result)=>unknown]),
      ['loss',()=>{throw new Error('fixture lost committed response')}],
    ]
    for (const [name,change] of mutations) {
      const f=await fixture()
      let effects=0
      const db=wrappedDatabase(f.h,sql=>/^(INSERT INTO margin_proposal_applications|UPDATE margin_annotations SET review_decision)/.test(sql),result=>{effects++;return change(result)})
      const body=action==='apply'?{revision:1}:{revision:1,decision:'ready',comments:'persisted',body:proposalBody('A {++saved++} body.')}
      const result=await workerCall(db,f.action(action),body)
      expect(result.status,name).toBe(503)
      expect((await result.json()).error.code).toBe('storage_unavailable')
      expect(effects).toBe(1)
      if(action==='apply') expect(snapshot(f.h)).toHaveLength(1)
      else expect(f.h.database.query('SELECT revision FROM margin_annotations')[0].revision).toBe(2)
      expect((await f.h.request('POST',f.action(action),{body})).status).toBe(409)
    }
  })

  it('ordinary projection refuses extra privileged fields, invalid state and failed storage replies', async () => {
    const f=await fixture()
    expect((await approve(f)).status).toBe(202)
    for(const change of [
      (r:D1Result)=>({...r,success:false}),
      (r:D1Result)=>({...r,results:r.results.map(row=>({...row,proposal_state:'pending'}))}),
      (r:D1Result)=>({...r,results:r.results.map(row=>({...row,approved_revision:1}))}),
    ]) {
      const db=wrappedDatabase(f.h,sql=>sql.startsWith('SELECT visible.'),change)
      expect((await workerCall(db,f.item)).status).toBe(503)
    }
    await expect(f.h.repository.findAnnotation({site:SITE,document:'/challenges/chapter-1'},f.id,principalKey(BOB),ADA)).rejects.toThrow('mismatch')
  })

  it('idempotent create replay projects creator state without disclosing privileged review metadata', async () => {
    const f=await fixture()
    const body=webAnnotation({source:CHAPTER_ONE,motivation:'editing'})
    const request=()=>handleMarginRequest(new Request('https://ernie.sg/api/margin/v1/annotations',{
      method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'123e4567-e89b-42d3-a456-426614174000'},body:JSON.stringify(body),
    }),{repository:f.h.repository,principal:BOB,now:()=>NOW,newId:()=> 'idempotent-proposal'})
    const created=await request()
    expect(created.status).toBe(201)
    const createdRow=await created.json()
    expect(createdRow['margin:proposalState']).toBeUndefined()
    const applied=await f.h.request('POST',`/proposals/${annotationIdFromIri(createdRow.id)}/apply`+scopeQuery(CHAPTER_ONE),{body:{revision:1}})
    expect(applied.status).toBe(202)
    const replay=await request()
    expect(replay.status).toBe(200)
    const row=await replay.json()
    expect(row['margin:proposalState']).toBe('approved')
    expect(row['margin:approvedRevision']).toBeUndefined()
  })

  it('pending withdrawal and comment tombstoning do not invent an application state', async () => {
    const f=await fixture()
    const withdrawn=await f.h.request('POST',f.action('withdraw'),{as:BOB})
    expect(withdrawn.status).toBe(200)
    expect((await withdrawn.json())['margin:proposalState']).toBeUndefined()
    const note=await f.h.request('POST','/annotations',{as:BOB,body:webAnnotation({source:CHAPTER_ONE,visibility:'public'})})
    const id=annotationIdFromIri((await note.json()).id)
    const reply=await f.h.request('POST','/annotations',{body:webAnnotation({source:CHAPTER_ONE,parentId:id})})
    expect(reply.status).toBe(201)
    const deleted=await f.h.request('DELETE',`/annotations/${id}${scopeQuery(CHAPTER_ONE)}`,{as:BOB})
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({'margin:deleted':true})
    expect(snapshot(f.h)).toEqual([])
  })

  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER,true,'1',null])('rejects invalid reviewed revision %s before any write', async revision => {
    const f=await fixture()
    for(const action of ['apply','review']) {
      const body=action==='apply'?{revision}:{revision,decision:'ready',comments:''}
      expect((await f.h.request('POST',f.action(action),{body})).status).toBe(400)
    }
    expect(snapshot(f.h)).toEqual([])
  })
})


describe('saved review and authenticated projection details', () => {
  it('metadata-only Save persists its reviewer decision at the unchanged current revision', async () => {
    const f=await fixture('private')
    const response=await f.h.request('POST',f.action('review'),{body:{revision:1,decision:'  ready  ',comments:'Keep this review private.'}})
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({'margin:revision':1})
    expect(f.h.database.query('SELECT review_decision,review_comments,reviewed_by,reviewed_revision FROM margin_annotations')[0]).toEqual({
      review_decision:'ready',review_comments:'Keep this review private.',reviewed_by:principalKey(ADA),reviewed_revision:1,
    })
    expect(snapshot(f.h)).toEqual([])
    expect((await approve(f)).status).toBe(202)
    expect((await f.h.request('GET',f.item)).status).toBe(404)
    const publicRow=await f.h.request('PATCH',f.item,{as:BOB,body:{'margin:visibility':'public'}})
    expect(publicRow.status).toBe(200)
    const ordinary=await (await f.h.request('GET',f.item,{as:null})).json()
    expect(JSON.stringify(ordinary)).not.toContain('Keep this review private.')
    expect(ordinary['margin:proposalState']).toBeUndefined()
  })

  it('missing identity and application storage surface as unavailable without read-time bootstrap', async () => {
    const f=await fixture()
    f.h.database.execute('DROP TABLE margin_allowlist')
    expect((await workerCall(f.h.database,f.item)).status).toBe(503)
    expect((await workerCall(f.h.database,f.action('apply'),{revision:1})).status).toBe(503)
    expect(f.h.database.query("SELECT name FROM sqlite_master WHERE name='margin_allowlist'")).toEqual([])
    f.h.database.execute('DROP TABLE margin_proposal_applications')
    await expect(f.h.request('GET',f.item,{as:null})).rejects.toThrow(/no such table/)
  })
})

describe('concurrent eligibility and immutable snapshot binding', () => {
  it('overlapping Apply calls approve exactly once', async () => {
    const f=await fixture()
    const responses=await Promise.all([approve(f),approve(f)])
    expect(responses.map(row=>row.status).sort()).toEqual([202,409])
    expect(snapshot(f.h)).toHaveLength(1)
  })

  it('overlapping revision Save and Apply cannot approve the wrong revision', async () => {
    const f=await fixture()
    const responses=await Promise.all([
      f.h.request('POST',f.action('review'),{body:{revision:1,decision:'revise',comments:'',body:proposalBody('A {++revised++} version.')}}),
      approve(f),
    ])
    const statuses=responses.map(row=>row.status)
    expect(statuses.filter(status=>status===409)).toHaveLength(1)
    if(statuses[0]===200) {
      expect(snapshot(f.h)).toEqual([])
      expect((await approve(f,2)).status).toBe(202)
      expect(snapshot(f.h)[0].revision).toBe(2)
    } else {
      expect(statuses).toEqual([409,202])
      expect(snapshot(f.h)[0].revision).toBe(1)
    }
  })

  it('cross-site or missing mapping forbids both mutations without changing proposal storage', async () => {
    const f=await fixture()
    f.h.database.execute('UPDATE margin_site_admins SET site=?',['https://other.example'])
    for(const action of ['review','apply']) {
      const body=action==='apply'?{revision:1}:{revision:1,decision:'ready',comments:''}
      expect((await f.h.request('POST',f.action(action),{body})).status).toBe(403)
    }
    expect(snapshot(f.h)).toEqual([])
    expect(f.h.database.query('SELECT review_decision FROM margin_annotations')[0].review_decision).toBeNull()
  })
})

describe('Save RETURNING has its own exact pending-row contract (DS060-R1)', () => {
  const impossible: [string,Record<string,unknown>][] = [
    ...['approved','pr_open','conflict','merged','closed','apply_failed'].flatMap(state => [
      [`${state}/revision`,{proposal_state:state,approved_revision:1}],
      [`${state}/missing revision`,{proposal_state:state}],
      [`${state}/null revision`,{proposal_state:state,approved_revision:null}],
    ] as [string,Record<string,unknown>][]),
    ['both null',{proposal_state:null,approved_revision:null}],
    ['state null only',{proposal_state:null}],
    ['revision only',{approved_revision:1}],
    ['revision null only',{approved_revision:null}],
    ['state undefined own property',{proposal_state:undefined}],
    ['revision undefined own property',{approved_revision:undefined}],
  ]
  it.each(['metadata','body','base'])('%s Save refuses every impossible application projection after preserving its committed pending review', async mode => {
    for(const [label,extra] of impossible) {
      const f=await fixture('private')
      let effects=0
      const db=wrappedDatabase(f.h,sql=>sql.startsWith('UPDATE margin_annotations SET review_decision'),result=>{
        effects++
        return {...result,results:result.results.map(row=>({...row,...extra}))}
      })
      const body={revision:1,decision:'saved',comments:'durable',...(mode==='body'?{body:proposalBody('A {++saved++} review.')}:{}) ,...(mode==='base'?{'margin:baseCommit':'d'.repeat(40)}:{})}
      const response=await workerCall(db,f.action('review'),body)
      expect.soft(response.status,label).toBe(503)
      expect.soft((await response.json()).error?.code,label).toBe('storage_unavailable')
      expect(effects).toBe(1)
      expect(snapshot(f.h)).toEqual([])
      expect(f.h.database.query('SELECT revision,review_decision,review_comments FROM margin_annotations')[0]).toEqual({revision:mode==='metadata'?1:2,review_decision:'saved',review_comments:'durable'})
      const recovered=await f.h.request('GET',f.item,{as:BOB})
      const pending=await recovered.json()
      expect(pending['margin:proposalState']).toBeUndefined()
      expect(pending['margin:approvedRevision']).toBeUndefined()
    }
  })

  it.each(['target','listing'])('%s read requires both actual nullable projection columns instead of an incomplete Save-shaped row', async surface => {
    for(const missing of [['proposal_state'],['approved_revision'],['proposal_state','approved_revision']]) {
      const f=await fixture()
      const db=wrappedDatabase(f.h,sql=>surface==='target'?sql.startsWith('SELECT EXISTS'):sql.startsWith('WITH review_authority'),result=>({
        ...result,results:result.results.map(row=>{
          if(surface==='target') {
            const value=JSON.parse(row.annotation as string)
            for(const key of missing) delete value[key]
            return {...row,annotation:JSON.stringify(value)}
          }
          if(row.review_kind!=='annotation') return row
          const value={...row}
          for(const key of missing) delete value[key]
          return value
        }),
      }))
      const response=await workerCall(db,surface==='target'?f.action('review'):'/proposals?scope=review',surface==='target'?{revision:1,decision:'ready',comments:''}:undefined)
      expect.soft(response.status,missing.join(',')).toBe(503)
      expect(snapshot(f.h)).toEqual([])
      expect.soft(f.h.database.query('SELECT review_decision FROM margin_annotations')[0].review_decision).toBeNull()
    }
  })
})

describe('DS060-R1 legitimate result contracts', () => {
  it.each(['metadata','body','base'])('%s Save returns only pending current data and can subsequently be approved', async mode => {
    const f=await fixture('private')
    const revision=mode==='metadata'?1:2
    const body={revision:1,decision:'ready',comments:'normal',...(mode==='body'?{body:proposalBody('A {++reviewed++} passage.')}:{}) ,...(mode==='base'?{'margin:baseCommit':'e'.repeat(40)}:{})}
    const result=await f.h.request('POST',f.action('review'),{body})
    expect(result.status).toBe(200)
    const row=await result.json()
    expect(row['margin:revision']).toBe(revision)
    expect(row['margin:proposalState']).toBeUndefined()
    expect(row['margin:approvedRevision']).toBeUndefined()
    expect((await approve(f,revision)).status).toBe(202)
    for(const state of ['approved','pr_open','conflict','merged','closed','apply_failed']) {
      f.h.database.execute('UPDATE margin_proposal_applications SET state=?',[state])
      const review=await f.h.request('GET','/proposals?scope=review&state='+state)
      expect(review.status).toBe(200)
      expect((await review.json()).annotations[0]).toMatchObject({'margin:proposalState':state,'margin:revision':revision,'margin:approvedRevision':revision})
    }
  })

  it.each(['target','listing'])('%s refuses partially null application bindings without inventing pending state', async surface => {
    for(const extra of [{proposal_state:'approved',approved_revision:null},{proposal_state:null,approved_revision:1}]) {
      const f=await fixture()
      const db=wrappedDatabase(f.h,sql=>surface==='target'?sql.startsWith('SELECT EXISTS'):sql.startsWith('WITH review_authority'),result=>({
        ...result,results:result.results.map(row=>surface==='target'?{...row,annotation:JSON.stringify({...JSON.parse(row.annotation as string),...extra})}:row.review_kind==='annotation'?{...row,...extra}:row),
      }))
      const response=await workerCall(db,surface==='target'?f.action('review'):'/proposals?scope=review',surface==='target'?{revision:1,decision:'ready',comments:''}:undefined)
      expect(response.status).toBe(503)
      expect(f.h.database.query('SELECT review_decision FROM margin_annotations')[0].review_decision).toBeNull()
      expect(snapshot(f.h)).toEqual([])
    }
  })
})
