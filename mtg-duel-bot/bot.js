require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const WebSocket = require('ws');

const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN?.trim();
const CLIENT_ID  = process.env.DISCORD_CLIENT_ID?.trim();
const RELAY_URL  = (process.env.RELAY_SERVER_URL || 'wss://mtg-duel-relay-tedy.fly.dev').trim();
const RELAY_HTTP = RELAY_URL.replace('wss://', 'https://').replace('ws://', 'http://');

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID env vars');
  process.exit(1);
}

const pendingRooms = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('create-game')
    .setDescription('Create a new MTG Duel room (up to 4 players)')
    .addStringOption(opt =>
      opt.setName('deck')
        .setDescription('Your Moxfield deck URL or deck ID')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('join-game')
    .setDescription('Join a room your opponent created')
    .addStringOption(opt =>
      opt.setName('code')
        .setDescription('4-letter room code')
        .setRequired(true)
        .setMinLength(4)
        .setMaxLength(4)
    )
    .addStringOption(opt =>
      opt.setName('deck')
        .setDescription('Your Moxfield deck URL or deck ID')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('mtg-help')
    .setDescription('How to use the MTG Duel bot'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  console.log('Registering slash commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registered.');
}

function normalizeDeckUrl(input) {
  const val = input.trim();
  if (val.startsWith('http')) return val;
  return `https://www.moxfield.com/decks/${val}/goldfish`;
}

// Include slot in launch URL so Electron knows which slot to attach to
function buildLaunchUrl(role, code, deckUrl, slot) {
  const slotParam = slot !== undefined ? `&slot=${slot}` : '';
  return `${RELAY_HTTP}/launch?role=${role}&code=${code}&deck=${encodeURIComponent(deckUrl)}${slotParam}`;
}

function launchButton(role, code, deckUrl, slot) {
  return new ButtonBuilder()
    .setLabel('🚀 Launch MTG Duel')
    .setStyle(ButtonStyle.Link)
    .setURL(buildLaunchUrl(role, code, deckUrl, slot));
}

function publicRoomEmbed(code, hostTag, players) {
  const connected = players.filter(Boolean).length;
  const slots = Array.from({ length: 4 }, (_, i) => {
    const p = players[i];
    return p && p.connected
      ? `${i === 0 ? '👑' : '⚔️'} ${p.name || `Player ${i + 1}`}`
      : `⬜ Slot ${i + 1} — open`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('⚔️ MTG Duel — Room Open')
    .setDescription(`**${hostTag}** is looking for opponents!\nRun \`/join-game ${code} [your deck]\` to join.`)
    .addFields(
      { name: 'Room Code', value: `\`\`\`${code}\`\`\``, inline: true },
      { name: 'Players', value: `${connected} / 4`, inline: true },
      { name: 'Roster', value: slots },
    )
    .setFooter({ text: 'Host starts the game when ready — up to 4 players' })
    .setTimestamp();
}

function privateHostEmbed(code, deckUrl) {
  return new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('🎮 Your Launch Link')
    .setDescription('Click below to open MTG Duel. Press **Begin the Duel** in the app once everyone has joined.')
    .addFields({ name: 'Your Deck', value: deckUrl })
    .setTimestamp();
}

function privateJoinEmbed(code, deckUrl, slot) {
  return new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle('🎮 Your Launch Link')
    .setDescription(`Click below to open MTG Duel and join room **${code}** as Player ${slot + 1}. The host will start when ready.`)
    .addFields({ name: 'Your Deck', value: deckUrl })
    .setTimestamp();
}

function gameStartedEmbed(code, players) {
  const names = players.filter(Boolean).map(p => p.name || 'Player').join(' vs ');
  return new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('🎮 Game Started!')
    .setDescription(`${names} — room \`${code}\` is underway. Good luck!`)
    .setTimestamp();
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🃏 MTG Duel Bot — Help')
    .setDescription('Play networked Moxfield games directly with friends via Discord.')
    .addFields(
      { name: '/create-game [deck]', value: "Creates a room (up to 4 players). Posts the code publicly. You get a private Launch button." },
      { name: '/join-game [code] [deck]', value: "Join an open room. You get a private Launch button." },
      { name: 'Starting', value: 'Host clicks **Begin the Duel** in the app — works with 2, 3, or 4 players.' },
      { name: 'Requirements', value: '• MTG Duel must be installed\n• Launch the app once to register the `mtgduel://` protocol' },
    );
}

function connectToRelay() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Relay timed out')); }, 10000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`✅ Logged in as ${client.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // ── /create-game ────────────────────────────────────────────────────────────
  if (commandName === 'create-game') {
    const deckUrl = normalizeDeckUrl(interaction.options.getString('deck'));
    const name    = interaction.user.username;

    await interaction.deferReply({ ephemeral: false });

    let ws;
    try { ws = await connectToRelay(); }
    catch (err) { await interaction.editReply({ content: `❌ Could not connect to relay: ${err.message}` }); return; }

    // Bot creates room and holds slot 0
    ws.send(JSON.stringify({ type: 'create-room', deckUrl, name }));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'room-created') {
        const { code } = msg;
        const players = Array.from({ length: 4 }, (_, i) =>
          i === 0 ? { name, connected: true } : null
        );

        pendingRooms.set(code, { hostId: interaction.user.id, hostTag: name, players, ws });

        // Public announcement
        await interaction.editReply({ embeds: [publicRoomEmbed(code, name, players)] });

        // Private launch button for host (slot 0)
        const row = new ActionRowBuilder().addComponents(launchButton('host', code, deckUrl, 0));
        await interaction.followUp({ embeds: [privateHostEmbed(code, deckUrl)], components: [row], ephemeral: true });

      } else if (msg.type === 'player-joined') {
        const room = pendingRooms.get(msg.players?.[0]?.name ? [...pendingRooms.entries()].find(([, r]) => r.hostId === interaction.user.id)?.[0] : null);
        // Update public embed
        try {
          const entry = [...pendingRooms.entries()].find(([, r]) => r.hostId === interaction.user.id);
          if (entry) {
            const [code, room] = entry;
            room.players = msg.players;
            await interaction.editReply({ embeds: [publicRoomEmbed(code, name, msg.players)] });
          }
        } catch {}

      } else if (msg.type === 'game-start') {
        try {
          const entry = [...pendingRooms.entries()].find(([, r]) => r.hostId === interaction.user.id);
          if (entry) {
            const [code, room] = entry;
            pendingRooms.delete(code);
            await interaction.editReply({ embeds: [gameStartedEmbed(code, msg.players)], components: [] });
          }
        } catch {}
      }
    });

    ws.on('close', () => {
      const entry = [...pendingRooms.entries()].find(([, r]) => r.hostId === interaction.user.id);
      if (entry) pendingRooms.delete(entry[0]);
    });

  // ── /join-game ──────────────────────────────────────────────────────────────
  } else if (commandName === 'join-game') {
    const code    = interaction.options.getString('code').trim().toUpperCase();
    const deckUrl = normalizeDeckUrl(interaction.options.getString('deck'));
    const name    = interaction.user.username;

    await interaction.deferReply({ ephemeral: true });

    let ws;
    try { ws = await connectToRelay(); }
    catch (err) { await interaction.editReply({ content: `❌ Relay timed out.` }); return; }

    // Bot reserves a guest slot
    ws.send(JSON.stringify({ type: 'join-room-bot', code, deckUrl, name }));

    const timeout = setTimeout(async () => {
      ws.terminate();
      await interaction.editReply({ content: '❌ Could not join room (timeout).' });
    }, 10000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'slot-reserved') {
        clearTimeout(timeout);
        const { playerIndex } = msg;

        // Give guest a launch button with their slot number baked in
        const row = new ActionRowBuilder().addComponents(launchButton('join', code, deckUrl, playerIndex));
        await interaction.editReply({ embeds: [privateJoinEmbed(code, deckUrl, playerIndex)], components: [row] });

        // Update public room embed via host's pending room
        const entry = [...pendingRooms.entries()].find(([c]) => c === code);
        if (entry) {
          const [, room] = entry;
          room.players = msg.players;
          try {
            // Find host's interaction — we can't easily re-edit it here
            // so we just update local state; the next player-joined broadcast will update it
          } catch {}
        }

      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.terminate();
        await interaction.editReply({ content: `❌ ${msg.message || 'Could not join room.'}` });
      }
    });

    ws.on('error', async (err) => {
      clearTimeout(timeout);
      await interaction.editReply({ content: `❌ Relay error: ${err.message}` });
    });

  // ── /mtg-help ───────────────────────────────────────────────────────────────
  } else if (commandName === 'mtg-help') {
    await interaction.reply({ embeds: [helpEmbed()], ephemeral: true });
  }
});

(async () => {
  await registerCommands();
  await client.login(BOT_TOKEN);
})();