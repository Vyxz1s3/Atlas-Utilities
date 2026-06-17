const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses a duration string like "10m", "2h", "1d" into milliseconds.
 * Supported units: s (seconds), m (minutes), h (hours), d (days).
 * Returns null if the string is not a valid duration.
 *
 * @param {string} str
 * @returns {number|null}
 */
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

// ── Interaction handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guild, member, channel } = interaction;

  // ── /ban ──────────────────────────────────────────────────────────────────
  if (commandName === 'ban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to ban members.', ephemeral: true });
    }

    const target = options.getMember('user');
    const reason = options.getString('reason') ?? 'No reason provided';

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    if (!target.bannable) {
      return interaction.reply({ content: '❌ I cannot ban this user. They may have a higher role than me.', ephemeral: true });
    }

    try {
      await target.ban({ reason });
      return interaction.reply({ content: `✅ Banned **${target.user.tag}**. Reason: ${reason}` });
    } catch (err) {
      console.error('/ban error:', err);
      return interaction.reply({ content: `❌ Failed to ban user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /kick ─────────────────────────────────────────────────────────────────
  if (commandName === 'kick') {
    if (!member.permissions.has(PermissionFlagsBits.KickMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to kick members.', ephemeral: true });
    }

    const target = options.getMember('user');
    const reason = options.getString('reason') ?? 'No reason provided';

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    if (!target.kickable) {
      return interaction.reply({ content: '❌ I cannot kick this user. They may have a higher role than me.', ephemeral: true });
    }

    try {
      await target.kick(reason);
      return interaction.reply({ content: `✅ Kicked **${target.user.tag}**. Reason: ${reason}` });
    } catch (err) {
      console.error('/kick error:', err);
      return interaction.reply({ content: `❌ Failed to kick user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /mute ─────────────────────────────────────────────────────────────────
  if (commandName === 'mute') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to mute members.', ephemeral: true });
    }

    const target = options.getMember('user');
    const durationStr = options.getString('duration', true);
    const reason = options.getString('reason') ?? 'No reason provided';

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    const ms = parseDuration(durationStr);
    if (!ms) {
      return interaction.reply({
        content: '❌ Invalid duration. Use a number followed by `s`, `m`, `h`, or `d` (e.g. `10m`, `2h`, `1d`).',
        ephemeral: true,
      });
    }

    // Discord's timeout cap is 28 days.
    const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
    if (ms > MAX_TIMEOUT_MS) {
      return interaction.reply({ content: '❌ Duration cannot exceed 28 days.', ephemeral: true });
    }

    if (!target.moderatable) {
      return interaction.reply({ content: '❌ I cannot mute this user. They may have a higher role than me.', ephemeral: true });
    }

    try {
      await target.timeout(ms, reason);
      return interaction.reply({ content: `✅ Muted **${target.user.tag}** for **${durationStr}**. Reason: ${reason}` });
    } catch (err) {
      console.error('/mute error:', err);
      return interaction.reply({ content: `❌ Failed to mute user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /unmute ───────────────────────────────────────────────────────────────
  if (commandName === 'unmute') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to unmute members.', ephemeral: true });
    }

    const target = options.getMember('user');

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    if (!target.moderatable) {
      return interaction.reply({ content: '❌ I cannot unmute this user. They may have a higher role than me.', ephemeral: true });
    }

    try {
      await target.timeout(null);
      return interaction.reply({ content: `✅ Unmuted **${target.user.tag}**.` });
    } catch (err) {
      console.error('/unmute error:', err);
      return interaction.reply({ content: `❌ Failed to unmute user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /warn ─────────────────────────────────────────────────────────────────
  if (commandName === 'warn') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to warn members.', ephemeral: true });
    }

    const target = options.getMember('user');
    const reason = options.getString('reason') ?? 'No reason provided';

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    try {
      await target.send(`⚠️ You have been warned in **${guild.name}**. Reason: ${reason}`).catch(() => null);
      return interaction.reply({ content: `⚠️ Warned **${target.user.tag}**. Reason: ${reason}` });
    } catch (err) {
      console.error('/warn error:', err);
      return interaction.reply({ content: `❌ Failed to warn user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /timeout ──────────────────────────────────────────────────────────────
  if (commandName === 'timeout') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '❌ You do not have permission to timeout members.', ephemeral: true });
    }

    const target = options.getMember('user');
    const durationStr = options.getString('duration', true);
    const reason = options.getString('reason') ?? 'No reason provided';

    if (!target) {
      return interaction.reply({ content: '❌ Could not find that user in this server.', ephemeral: true });
    }

    const ms = parseDuration(durationStr);
    if (!ms) {
      return interaction.reply({
        content: '❌ Invalid duration. Use a number followed by `s`, `m`, `h`, or `d` (e.g. `10m`, `2h`, `1d`).',
        ephemeral: true,
      });
    }

    const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
    if (ms > MAX_TIMEOUT_MS) {
      return interaction.reply({ content: '❌ Duration cannot exceed 28 days.', ephemeral: true });
    }

    if (!target.moderatable) {
      return interaction.reply({ content: '❌ I cannot timeout this user. They may have a higher role than me.', ephemeral: true });
    }

    try {
      await target.timeout(ms, reason);
      return interaction.reply({ content: `⏱️ Timed out **${target.user.tag}** for **${durationStr}**. Reason: ${reason}` });
    } catch (err) {
      console.error('/timeout error:', err);
      return interaction.reply({ content: `❌ Failed to timeout user: ${err.message}`, ephemeral: true });
    }
  }

  // ── /clear ────────────────────────────────────────────────────────────────
  if (commandName === 'clear') {
    if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '❌ You do not have permission to delete messages.', ephemeral: true });
    }

    const amount = options.getInteger('amount', true);

    if (amount < 2 || amount > 100) {
      return interaction.reply({ content: '❌ Amount must be between 2 and 100.', ephemeral: true });
    }

    try {
      const deleted = await channel.bulkDelete(amount, true);
      return interaction.reply({ content: `🗑️ Deleted **${deleted.size}** message(s).`, ephemeral: true });
    } catch (err) {
      console.error('/clear error:', err);
      return interaction.reply({ content: `❌ Failed to delete messages: ${err.message}`, ephemeral: true });
    }
  }

  // ── /slowmode ─────────────────────────────────────────────────────────────
  if (commandName === 'slowmode') {
    if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ content: '❌ You do not have permission to manage channels.', ephemeral: true });
    }

    const seconds = options.getInteger('seconds', true);

    if (seconds < 0 || seconds > 21600) {
      return interaction.reply({ content: '❌ Slowmode must be between 0 and 21600 seconds (6 hours).', ephemeral: true });
    }

    try {
      await channel.setRateLimitPerUser(seconds);
      if (seconds === 0) {
        return interaction.reply({ content: '✅ Slowmode disabled.' });
      }
      return interaction.reply({ content: `✅ Slowmode set to **${seconds}** second(s).` });
    } catch (err) {
      console.error('/slowmode error:', err);
      return interaction.reply({ content: `❌ Failed to set slowmode: ${err.message}`, ephemeral: true });
    }
  }
});

// ── Ready & command registration ──────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Bot ready — logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a user from the server')
      .addUserOption((o) => o.setName('user').setDescription('The user to ban').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the ban')),

    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a user from the server')
      .addUserOption((o) => o.setName('user').setDescription('The user to kick').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the kick')),

    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Mute a user for a specified duration (uses Discord timeout)')
      .addUserOption((o) => o.setName('user').setDescription('The user to mute').setRequired(true))
      .addStringOption((o) =>
        o.setName('duration').setDescription('Duration (e.g. 10m, 2h, 1d)').setRequired(true),
      )
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the mute')),

    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Remove a timeout from a user')
      .addUserOption((o) => o.setName('user').setDescription('The user to unmute').setRequired(true)),

    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Send a warning to a user via DM')
      .addUserOption((o) => o.setName('user').setDescription('The user to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning')),

    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription("Apply Discord's built-in timeout to a user")
      .addUserOption((o) => o.setName('user').setDescription('The user to timeout').setRequired(true))
      .addStringOption((o) =>
        o.setName('duration').setDescription('Duration (e.g. 10m, 2h, 1d)').setRequired(true),
      )
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the timeout')),

    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Bulk-delete messages in the current channel')
      .addIntegerOption((o) =>
        o.setName('amount').setDescription('Number of messages to delete (2–100)').setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set the slowmode delay for the current channel')
      .addIntegerOption((o) =>
        o.setName('seconds').setDescription('Slowmode delay in seconds (0 to disable, max 21600)').setRequired(true),
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔄 Registering moderation slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log('✅ Moderation slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
