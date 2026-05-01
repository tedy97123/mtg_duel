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

const { shell } = require('electron');
const https     = require('https');
const path      = require('path');
const fs        = require('fs');

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI          = 'https://mtg-duel-relay-tedy.fly.dev/auth/callback';

const DISCORD_AUTH_URL =
  `https://discord.com/oauth2/authorize` +
  `?client_id=${DISCORD_CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=identify`;

let currentUser = null;

function startDiscordAuth() {
  shell.openExternal(DISCORD_AUTH_URL);
}

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
    }).toString();

    const req = https.request({
      hostname: 'discord.com',
      path:     '/api/oauth2/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse Discord token')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getDiscordUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path:     '/api/users/@me',
      method:   'GET',
      headers:  { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse Discord user')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function handleAuthCallback(code) {
  const tokenData = await exchangeCode(code);
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

  const discordUser = await getDiscordUser(tokenData.access_token);
  if (!discordUser.id) throw new Error('Could not get Discord user');

  // Require db here (not at top level) to avoid circular load issues
  const { supabase } = require('./db');
  const { data: dbUser, error: dbError } = await supabase
    .from('users')
    .upsert(
      { discord_id: discordUser.id, username: discordUser.username, avatar: discordUser.avatar },
      { onConflict: 'discord_id' }
    )
    .select()
    .single();

  console.log('[Auth] DB user:', dbUser);
  if (dbError) console.error('[Auth] DB error:', dbError);

  currentUser = {
    id:         dbUser?.id,
    discord_id: discordUser.id,
    username:   discordUser.username,
    avatar:     discordUser.avatar,
  };

  return currentUser;
}

function getUser()  { return currentUser; }
function logout()   { currentUser = null; }

function getSessionPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'mtgduel-session.json');
}

function saveSession(user) {
  try { fs.writeFileSync(getSessionPath(), JSON.stringify(user), 'utf8'); }
  catch (err) { console.warn('[Auth] Could not save session:', err.message); }
}

function loadSession() {
  try {
    const raw  = fs.readFileSync(getSessionPath(), 'utf8');
    const user = JSON.parse(raw);
    if (user?.discord_id) { currentUser = user; return user; }
  } catch {}
  return null;
}

function clearSession() {
  try { fs.unlinkSync(getSessionPath()); } catch {}
  currentUser = null;
}

module.exports = {
  startDiscordAuth,
  handleAuthCallback,
  getUser,
  logout,
  saveSession,
  loadSession,
  clearSession,
};