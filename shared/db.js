// ── Load env FIRST before anything else ──────────────────────────────────────
// ── Load env FIRST ────────────────────────────────────────────────────────────
try {
  // Try loading from package.json extraMetadata (production)
  const pkgPaths = [
    require('path').join(__dirname, '..', '..', 'package.json'),
    require('path').join(process.resourcesPath || '', 'app', 'package.json'),
    require('path').join(process.resourcesPath || '', 'app.asar', 'package.json'),
  ];
  for (const p of pkgPaths) {
    try {
      const pkg = require(p);
      if (pkg.env) { Object.assign(process.env, pkg.env); break; }
    } catch {}
  }
} catch {}

// Also try dotenv for dev
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch {}
const { createClient } = require('@supabase/supabase-js');

console.log('SUPABASE_URL:', process.env.SUPABASE_URL);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Users ─────────────────────────────────────────────────────────────────────
async function upsertUser({ discord_id, username, avatar }) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ discord_id, username, avatar }, { onConflict: 'discord_id' })
    .select()
    .single();

  if (error) { console.error('[DB] upsertUser:', error); return null; }
  return data;
}

async function getUserByDiscordId(discord_id) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', discord_id)
    .single();
  return data || null;
}

// ── Decks ─────────────────────────────────────────────────────────────────────
async function getDecks(user_id) {
  const { data } = await supabase
    .from('decks')
    .select('*')
    .eq('user_id', user_id)
    .order('last_used', { ascending: false });
  return data || [];
}

async function addDeck(user_id, name, url) {
  const { data, error } = await supabase
    .from('decks')
    .insert({ user_id, name, url })
    .select()
    .single();
  if (error) { console.error('[DB] addDeck:', error); return null; }
  return data;
}

async function deleteDeck(id) {
  await supabase.from('decks').delete().eq('id', id);
}

async function markDeckUsed(id) {
  const { data } = await supabase.from('decks').select('use_count').eq('id', id).single();
  if (!data) return;
  await supabase.from('decks').update({
    last_used: new Date().toISOString(),
    use_count: (data.use_count || 0) + 1,
  }).eq('id', id);
}

async function getLastUsedDeck(user_id) {
  const { data } = await supabase
    .from('decks')
    .select('*')
    .eq('user_id', user_id)
    .order('last_used', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ── Matches ───────────────────────────────────────────────────────────────────
async function createMatch(room_code, player_count) {
  const { data, error } = await supabase
    .from('matches')
    .insert({ room_code, player_count })
    .select()
    .single();
  if (error) { console.error('[DB] createMatch:', error); return null; }
  return data;
}

async function addMatchPlayer(match_id, { user_id, discord_id, username, deck_url, player_index }) {
  await supabase.from('match_players').insert({
    match_id, user_id, discord_id, username, deck_url, player_index,
  });
}

async function getRecentMatches(user_id, limit = 10) {
  const { data } = await supabase
    .from('match_players')
    .select('result, deck_url, matches(id, room_code, started_at, player_count)')
    .eq('user_id', user_id)
    .order('id', { ascending: false })
    .limit(limit);
  return data || [];
}

async function getStats(user_id) {
  const { data } = await supabase
    .from('match_players')
    .select('result')
    .eq('user_id', user_id);
  if (!data) return { games: 0, wins: 0 };
  return {
    games: data.length,
    wins:  data.filter(m => m.result === 'win').length,
  };
}

module.exports = {
  supabase,
  upsertUser,
  getUserByDiscordId,
  getDecks,
  addDeck,
  deleteDeck,
  markDeckUsed,
  getLastUsedDeck,
  createMatch,
  addMatchPlayer,
  getRecentMatches,
  getStats,
};