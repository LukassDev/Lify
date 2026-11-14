import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { SUPABASE_SETUP_SQL } from '../../src/storage/supabase/setup';

test('Supabase setup enforces per-user reads, authenticated writes, tombstones and retry idempotency', async () => {
  const db = new PGlite();
  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values('${userA}'),('${userB}');
    `);
    await db.exec(SUPABASE_SETUP_SQL);
    await db.exec(SUPABASE_SETUP_SQL); // Safe to run the setup guide more than once.
    const login = async (id: string) => { await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); };
    const change = async (op: string, payload: unknown) => db.query('select public.lify_apply_changes($1::jsonb)', [JSON.stringify([{ kind: 'favorite', entity_key: 'yt:one', payload, op_id: op.repeat(32) }])]);
    await assert.rejects(change('a', { title: 'unauthenticated' }), /Authentication required/);
    await login(userA);
    await change('a', { title: 'first' });
    await change('b', null);
    await change('a', { title: 'first' });
    const result = await db.query<{ payload: unknown }>('select payload from public.lify_sync_records');
    assert.equal(result.rows[0].payload, null, 'retry of an acknowledged old write cannot resurrect a deleted favorite');
    await db.exec('set role authenticated');
    assert.equal((await db.query('select * from public.lify_sync_records')).rows.length, 1);
    await login(userB);
    assert.equal((await db.query('select * from public.lify_sync_records')).rows.length, 0, 'another account cannot read the first user’s data');
    await change('c', { title: 'user B' });
    assert.equal((await db.query('select * from public.lify_sync_records')).rows.length, 1);
    await assert.rejects(db.query("insert into public.lify_sync_records(user_id,kind,entity_key) values($1,'favorite','other')", [userB]), /permission denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(change('d', null), /permission denied/);
    await db.exec('reset role');
    assert.equal((await db.query("select * from pg_publication_tables where pubname='supabase_realtime' and tablename='lify_sync_records'")).rows.length, 1);
  } finally { await db.close(); }
});
