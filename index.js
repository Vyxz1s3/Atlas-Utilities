const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
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

// ── Anti-Raid state ──────────────────────────────────────────────────────────
// Per-guild configuration and join-event tracking for the anti-raid system.
//
// raidConfig  — Map<guildId, { enabled: boolean, threshold: number, window: number }>
//               threshold : max users allowed to join within `window` seconds
//               window    : rolling time window in seconds
//
// joinLog     — Map<guildId, { userId: string, joinedAt: number }[]>
//               Tracks recent join timestamps so we can detect a raid burst.
const raidConfig = new Map();
const joinLog    = new Map();

// ── Shadowban list ───────────────────────────────────────────────────────────
// Per-guild set of user IDs that were shadowbanned so we can surface them
// via /unshadowban and distinguish them from regular bans.
// Map<guildId, Set<userId>>
const shadowbannedUsers = new Map();

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

  // ── /antiraid ────────────────────────────────────────────────────────────
  if (commandName === 'antiraid') {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ You need the **Administrator** permission to use this command.', ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();
    const guildId    = guild.id;

    if (subcommand === 'enable') {
      const threshold = interaction.options.getInteger('threshold') ?? 5;
      const window    = interaction.options.getInteger('window')    ?? 10;

      raidConfig.set(guildId, { enabled: true, threshold, window });
      joinLog.set(guildId, []); // Reset the log when (re-)enabling.

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00c853)
            .setTitle('🛡️ Anti-Raid Enabled')
            .setDescription(
              `Anti-raid protection is now **active**.\n` +
              `**Threshold:** ${threshold} users\n` +
              `**Window:** ${window} seconds\n\n` +
              `If **${threshold}** or more users join within **${window}s**, they will all be automatically banned.`,
            )
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    if (subcommand === 'disable') {
      const existing = raidConfig.get(guildId);
      if (existing) {
        raidConfig.set(guildId, { ...existing, enabled: false });
      }
      joinLog.set(guildId, []);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff6d00)
            .setTitle('🛡️ Anti-Raid Disabled')
            .setDescription('Anti-raid protection has been **disabled**.')
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }

    if (subcommand === 'status') {
      const cfg = raidConfig.get(guildId);
      if (!cfg) {
        return interaction.reply({ content: '⚠️ Anti-raid has not been configured for this server yet. Use `/antiraid enable` to set it up.', ephemeral: true });
      }

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(cfg.enabled ? 0x00c853 : 0xff6d00)
            .setTitle('🛡️ Anti-Raid Status')
            .addFields(
              { name: 'Status',    value: cfg.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
              { name: 'Threshold', value: `${cfg.threshold} users`,                  inline: true },
              { name: 'Window',    value: `${cfg.window} seconds`,                   inline: true },
            )
            .setTimestamp(),
        ],
        ephemeral: true,
      });
    }
  }

  // ── /massban ─────────────────────────────────────────────────────────────
  if (commandName === 'massban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ You need the **Ban Members** permission to use this command.', ephemeral: true });
    }

    const rawIds = interaction.options.getString('users', true);
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

    // Parse space- or comma-separated user IDs / mentions (<@123456789>).
    const userIds = [...new Set(
      rawIds
        .split(/[\s,]+/)
        .map((token) => token.replace(/^<@!?(\d+)>$/, '$1').trim())
        .filter((token) => /^\d{17,20}$/.test(token)),
    )];

    if (userIds.length === 0) {
      return interaction.reply({ content: '❌ No valid user IDs found. Provide space- or comma-separated IDs or mentions.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const results = await Promise.allSettled(
      userIds.map((id) =>
        guild.members.ban(id, { reason: `[Massban by ${interaction.user.tag}] ${reason}`, deleteMessageSeconds: 86400 }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed    = results.filter((r) => r.status === 'rejected').length;

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(succeeded > 0 ? 0x00c853 : 0xff0000)
          .setTitle('🔨 Massban Complete')
          .setDescription(
            `**Targets:** ${userIds.length}\n` +
            `**Banned:** ${succeeded}\n` +
            `**Failed:** ${failed}\n` +
            `**Reason:** ${reason}`,
          )
          .setFooter({ text: `Executed by ${interaction.user.tag}` })
          .setTimestamp(),
      ],
    });
  }

  // ── /softban ─────────────────────────────────────────────────────────────
  if (commandName === 'softban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ You need the **Ban Members** permission to use this command.', ephemeral: true });
    }

    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

    await interaction.deferReply({ ephemeral: true });

    try {
      // Ban (deletes last 7 days of messages), then immediately unban.
      await guild.members.ban(target.id, {
        reason: `[Softban by ${interaction.user.tag}] ${reason}`,
        deleteMessageSeconds: 604800, // 7 days
      });
      await guild.members.unban(target.id, `Softban — immediate unban after message deletion`);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff9800)
            .setTitle('🧹 Softban Applied')
            .setDescription(
              `**User:** ${target.tag} (${target.id})\n` +
              `**Reason:** ${reason}\n\n` +
              `${target.tag} has been removed from the server and their recent messages deleted. They may rejoin with a new invite.`,
            )
            .setFooter({ text: `Executed by ${interaction.user.tag}` })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('/softban error:', err);
      return interaction.editReply({ content: `❌ Softban failed: ${err.message}` });
    }
  }

  // ── /shadowban ───────────────────────────────────────────────────────────
  if (commandName === 'shadowban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ You need the **Ban Members** permission to use this command.', ephemeral: true });
    }

    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const guildId = guild.id;

    await interaction.deferReply({ ephemeral: true });

    try {
      // Ban silently — no DM, no public announcement.
      await guild.members.ban(target.id, {
        reason: `[Shadowban by ${interaction.user.tag}] ${reason}`,
        deleteMessageSeconds: 86400,
      });

      // Record in the shadowban list.
      if (!shadowbannedUsers.has(guildId)) shadowbannedUsers.set(guildId, new Set());
      shadowbannedUsers.get(guildId).add(target.id);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x37474f)
            .setTitle('👤 Shadowban Applied')
            .setDescription(
              `**User:** ${target.tag} (${target.id})\n` +
              `**Reason:** ${reason}\n\n` +
              `${target.tag} has been silently banned. No notification was sent. Use \`/unshadowban\` to reverse this.`,
            )
            .setFooter({ text: `Executed by ${interaction.user.tag}` })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('/shadowban error:', err);
      return interaction.editReply({ content: `❌ Shadowban failed: ${err.message}` });
    }
  }

  // ── /unshadowban ─────────────────────────────────────────────────────────
  if (commandName === 'unshadowban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return interaction.reply({ content: '❌ You need the **Ban Members** permission to use this command.', ephemeral: true });
    }

    const userId  = interaction.options.getString('userid', true).trim();
    const reason  = interaction.options.getString('reason') ?? 'No reason provided';
    const guildId = guild.id;

    if (!/^\d{17,20}$/.test(userId)) {
      return interaction.reply({ content: '❌ Invalid user ID. Please provide a valid Discord user ID (17–20 digits).', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await guild.members.unban(userId, `[Unshadowban by ${interaction.user.tag}] ${reason}`);

      // Remove from the shadowban list.
      shadowbannedUsers.get(guildId)?.delete(userId);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00c853)
            .setTitle('👤 Shadowban Removed')
            .setDescription(
              `**User ID:** ${userId}\n` +
              `**Reason:** ${reason}\n\n` +
              `The user has been unbanned and removed from the shadowban list.`,
            )
            .setFooter({ text: `Executed by ${interaction.user.tag}` })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('/unshadowban error:', err);
      return interaction.editReply({ content: `❌ Unshadowban failed: ${err.message}` });
    }
  }
});

// ── Anti-Raid: guildMemberAdd listener ──────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const guildId = member.guild.id;
  const config  = raidConfig.get(guildId);

  // Skip if anti-raid is not configured or not enabled for this guild.
  if (!config || !config.enabled) return;

  const now = Date.now();
  const windowMs = config.window * 1000;

  // Initialise the join log for this guild if needed.
  if (!joinLog.has(guildId)) joinLog.set(guildId, []);
  const log = joinLog.get(guildId);

  // Record this join.
  log.push({ userId: member.id, joinedAt: now });

  // Prune entries older than the configured window.
  const cutoff = now - windowMs;
  const recent = log.filter((entry) => entry.joinedAt >= cutoff);
  joinLog.set(guildId, recent);

  // Check whether the burst threshold has been exceeded.
  if (recent.length < config.threshold) return;

  console.log(
    `⚠️  Raid detected in guild ${guildId} — ${recent.length} joins in ${config.window}s. Banning ${recent.length} users.`,
  );

  // Clear the log immediately so we don't re-trigger on the next join.
  joinLog.set(guildId, []);

  // Ban every user that joined during the raid window.
  const banReason = `[Anti-Raid] Automatic ban — joined during a raid (${recent.length} users in ${config.window}s)`;
  const results = await Promise.allSettled(
    recent.map(({ userId }) =>
      member.guild.members
        .ban(userId, { reason: banReason, deleteMessageSeconds: 86400 })
        .catch((err) => {
          console.error(`Anti-raid: failed to ban ${userId}:`, err.message);
          throw err;
        }),
    ),
  );

  const banned  = results.filter((r) => r.status === 'fulfilled').length;
  const failed  = results.filter((r) => r.status === 'rejected').length;
  console.log(`Anti-raid: banned ${banned} users, ${failed} failed.`);

  // Attempt to log the action to the first available text channel.
  try {
    const channels = await member.guild.channels.fetch();
    const logChannel = channels.find((ch) => ch?.type === ChannelType.GuildText);
    if (logChannel) {
      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('🚨 Anti-Raid Triggered')
        .setDescription(
          `Detected **${recent.length}** users joining within **${config.window}s** (threshold: ${config.threshold}).\n` +
          `**Banned:** ${banned} | **Failed:** ${failed}`,
        )
        .setTimestamp();
      await logChannel.send({ embeds: [embed] });
    }
  } catch (logErr) {
    console.error('Anti-raid: failed to send log message:', logErr.message);
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

    // ── /antiraid ───────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('antiraid')
      .setDescription('Configure automatic raid detection and banning')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Enable anti-raid protection with optional thresholds')
          .addIntegerOption((opt) =>
            opt
              .setName('threshold')
              .setDescription('Number of joins that triggers a raid ban (default: 5)')
              .setMinValue(2)
              .setMaxValue(100),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('window')
              .setDescription('Time window in seconds to count joins within (default: 10)')
              .setMinValue(1)
              .setMaxValue(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disable')
          .setDescription('Disable anti-raid protection'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('status')
          .setDescription('Show the current anti-raid configuration'),
      ),

    // ── /massban ────────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('massban')
      .setDescription('Ban multiple users at once by ID or mention')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((opt) =>
        opt
          .setName('users')
          .setDescription('Space- or comma-separated user IDs or mentions')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Reason for the bans'),
      ),

    // ── /softban ────────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('softban')
      .setDescription('Ban then immediately unban a user — removes their messages without a permanent ban')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription('The user to softban')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Reason for the softban'),
      ),

    // ── /shadowban ──────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('shadowban')
      .setDescription('Silently ban a user without notifying them')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((opt) =>
        opt
          .setName('user')
          .setDescription('The user to shadowban')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Internal reason (not shown to the user)'),
      ),

    // ── /unshadowban ────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('unshadowban')
      .setDescription('Unban a previously shadowbanned user')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((opt) =>
        opt
          .setName('userid')
          .setDescription('The Discord user ID to unshadowban')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('reason')
          .setDescription('Reason for removing the shadowban'),
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔄 Registering moderation slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log('✅ Moderation slash commands registered globally: /ban, /kick, /mute, /unmute, /warn, /timeout, /clear, /slowmode, /antiraid, /massban, /softban, /shadowban, /unshadowban');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
