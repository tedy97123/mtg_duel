require('dotenv').config();
console.log('TOKEN:', JSON.stringify(process.env.DISCORD_BOT_TOKEN));
console.log('CLIENT:', JSON.stringify(process.env.DISCORD_CLIENT_ID));
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

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
const CLIENT_ID = process.env.DISCORD_CLIENT_ID?.trim();
const RELAY_URL = (process.env.RELAY_SERVER_URL || 'wss://mtg-duel-relay.fly.dev').trim();

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID env vars');
  process.exit(1);
}

const pendingRooms = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('create-game')
    .setDescription('Create a new MTG Duel room — your opponent will join with the code')
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
        .setDescription('4-letter room code from your opponent')
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

function buildLaunchUrl(role, code, deckUrl) {
  return `mtgduel://${role}/${code}?deck=${encodeURIComponent(deckUrl)}`;
}

function launchButton(role, code, deckUrl) {
  return new ButtonBuilder()
    .setLabel('🚀 Launch MTG Duel')
    .setStyle(ButtonStyle.Link)
    .setURL(buildLaunchUrl(role, code, deckUrl));
}

function roomCreatedEmbed(code, deckUrl) {
  return new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle('⚔️ MTG Duel — Room Created')
    .setDescription('Click **Launch MTG Duel** to open the app. Share your room code with your opponent so they can run `/join-game`.')
    .addFields(
      { name: 'Room Code', value: `\`\`\`${code}\`\`\``, inline: true },
      { name: 'Your Deck', value: deckUrl, inline: false },
    )
    .setFooter({ text: 'Waiting for opponent to join...' })
    .setTimestamp();
}

function gameStartEmbed(code, opponentTag, role) {
  return new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle('✅ Opponent Connected — Game Starting!')
    .setDescription(`**${opponentTag}** has joined room \`${code}\`. Click Launch to start playing!`)
    .setFooter({ text: role === 'host' ? 'You are the HOST' : 'You are the GUEST' })
    .setTimestamp();
}

function joinedEmbed(code, deckUrl) {
  return new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle('⚔️ MTG Duel — Joining Room')
    .setDescription('Click **Launch MTG Duel** to open the app and connect.')
    .addFields(
      { name: 'Room Code', value: `\`\`\`${code}\`\`\``, inline: true },
      { name: 'Your Deck', value: deckUrl, inline: false },
    )
    .setTimestamp();
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🃏 MTG Duel Bot — Help')
    .setDescription('Play networked Moxfield games directly with friends via Discord.')
    .addFields(
      { name: '/create-game [deck]', value: "Creates a room. You'll get a room code and a Launch button. Share the code with your opponent." },
      { name: '/join-game [code] [deck]', value: "Join a room your opponent created with their 4-letter code." },
      { name: 'Requirements', value: '• MTG Duel must be installed\n• Launch the app once normally to register the `mtgduel://` protocol' },
    );
}

function createRelayRoom(deckUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Relay connection timed out')); }, 10000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'create-room', deckUrl })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'room-created') { clearTimeout(timeout); resolve({ code: msg.code, ws }); }
      else if (msg.type === 'error') { clearTimeout(timeout); ws.terminate(); reject(new Error(msg.message || 'Relay error')); }
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'create-game') {
    const deckUrl = normalizeDeckUrl(interaction.options.getString('deck'));
    await interaction.deferReply({ ephemeral: true });

    let code, ws;
    try {
      ({ code, ws } = await createRelayRoom(deckUrl));
    } catch (err) {
      await interaction.editReply({ content: `❌ Could not connect to relay server: ${err.message}` });
      return;
    }

    pendingRooms.set(code, { creatorId: interaction.user.id, creatorTag: interaction.user.tag, creatorDeck: deckUrl, ws });

    try {
      const dm = await interaction.user.createDM();
      const row = new ActionRowBuilder().addComponents(launchButton('host', code, deckUrl));
      await dm.send({ embeds: [roomCreatedEmbed(code, deckUrl)], components: [row] });
    } catch {}

    await interaction.editReply({
      content: `✅ Room **${code}** created! Check your DMs for the launch button.\nShare the code \`${code}\` with your opponent and have them run \`/join-game\`.`,
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'game-start') {
        pendingRooms.delete(code);
        try {
          const dm = await interaction.user.createDM();
          const row = new ActionRowBuilder().addComponents(launchButton('host', code, deckUrl));
          await dm.send({ embeds: [gameStartEmbed(code, 'Your opponent', 'host')], components: [row] });
        } catch {}
      }
    });

    ws.on('close', () => pendingRooms.delete(code));

  } else if (commandName === 'join-game') {
    const code = interaction.options.getString('code').trim().toUpperCase();
    const deckUrl = normalizeDeckUrl(interaction.options.getString('deck'));
    await interaction.deferReply({ ephemeral: true });

    const ws = new WebSocket(RELAY_URL);
    let joined = false;

    const timeout = setTimeout(async () => {
      if (!joined) { ws.terminate(); await interaction.editReply({ content: '❌ Could not connect to relay server (timeout).' }); }
    }, 10000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'join-room', code, deckUrl })));

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'game-start') {
        joined = true;
        clearTimeout(timeout);

        try {
          const dm = await interaction.user.createDM();
          const row = new ActionRowBuilder().addComponents(launchButton('join', code, deckUrl));
          await dm.send({ embeds: [joinedEmbed(code, deckUrl)], components: [row] });
        } catch {}

        await interaction.editReply({ content: `✅ Joined room **${code}**! Check your DMs for the launch button.` });

        const room = pendingRooms.get(code);
        if (room) {
          try {
            const hostUser = await client.users.fetch(room.creatorId);
            const dm = await hostUser.createDM();
            const row = new ActionRowBuilder().addComponents(launchButton('host', code, room.creatorDeck));
            await dm.send({ embeds: [gameStartEmbed(code, interaction.user.tag, 'host')], components: [row] });
          } catch {}
          pendingRooms.delete(code);
        }

      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.terminate();
        await interaction.editReply({ content: `❌ ${msg.message || 'Room not found or already full.'}` });
      }
    });

    ws.on('error', async (err) => {
      clearTimeout(timeout);
      if (!joined) await interaction.editReply({ content: `❌ Relay error: ${err.message}` });
    });

  } else if (commandName === 'mtg-help') {
    await interaction.reply({ embeds: [helpEmbed()], ephemeral: true });
  }
});

(async () => {
  await registerCommands();
  await client.login(BOT_TOKEN);
})();
