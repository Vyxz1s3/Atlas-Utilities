const {
  Client,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  EmbedBuilder,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const express = require('express');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const app = express();
app.use(express.json());

// Stores embedData keyed by the selector message ID so the interaction
// handler can retrieve it when the user picks a channel.
const pendingEmbeds = new Map();

app.post('/webhook', async (req, res) => {
  try {
    const { guildId, embedData } = req.body;

    if (!guildId || !embedData) {
      return res.status(400).json({ error: 'guildId and embedData are required' });
    }

    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const textChannels = channels.filter((ch) => ch?.type === ChannelType.GuildText);

    if (textChannels.size === 0) {
      return res.status(400).json({ error: 'No text channels found in this guild' });
    }

    // Discord select menus support a maximum of 25 options.
    const options = textChannels
      .map((ch) => ({ label: `#${ch.name}`, value: ch.id }))
      .slice(0, 25);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('embed_channel_select')
      .setPlaceholder('Select a channel to send the embed to')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const promptEmbed = new EmbedBuilder()
      .setTitle('Select a Channel')
      .setDescription('Choose the channel where the embed should be sent.')
      .setColor(0x0099ff);

    // Send the channel-picker to the guild's system channel (or the first
    // available text channel if no system channel is configured).
    const targetChannel =
      guild.systemChannel ?? textChannels.first();

    const msg = await targetChannel.send({ embeds: [promptEmbed], components: [row] });
    pendingEmbeds.set(msg.id, { embedData, guildId });

    return res.json({ success: true, messageId: msg.id });
  } catch (err) {
    console.error('POST /webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

client.on('interactionCreate', async (interaction) => {
  // ── /deploy slash command ────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
    const url = interaction.options.getString('url', true);

    await interaction.deferReply({ ephemeral: true });

    // Validate URL format before fetching.
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('URL must use http or https.');
      }
    } catch {
      return interaction.editReply({ content: '❌ Invalid URL provided. Please supply a valid `http` or `https` URL.' });
    }

    // Fetch the webhook payload from the provided URL.
    let embedData;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return interaction.editReply({ content: `❌ Failed to fetch URL — server responded with \`${response.status} ${response.statusText}\`.` });
      }
      embedData = await response.json();
    } catch (err) {
      console.error('/deploy fetch error:', err);
      return interaction.editReply({ content: `❌ Could not fetch or parse the URL: ${err.message}` });
    }

    // Build the channel-picker dropdown from the guild's text channels.
    const guild = interaction.guild;
    const channels = await guild.channels.fetch();
    const textChannels = channels.filter((ch) => ch?.type === ChannelType.GuildText);

    if (textChannels.size === 0) {
      return interaction.editReply({ content: '❌ No text channels found in this server.' });
    }

    const options = textChannels
      .map((ch) => ({ label: `#${ch.name}`, value: ch.id }))
      .slice(0, 25);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('embed_channel_select')
      .setPlaceholder('Select a channel to send the embed to')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const promptEmbed = new EmbedBuilder()
      .setTitle('Select a Channel')
      .setDescription('Choose the channel where the embed should be sent.')
      .setColor(0x0099ff);

    // Send the picker as a follow-up so we have a stable message ID to key on.
    const msg = await interaction.followUp({
      embeds: [promptEmbed],
      components: [row],
      ephemeral: true,
    });

    pendingEmbeds.set(msg.id, { embedData, guildId: guild.id });
    return;
  }

  // ── Channel select-menu handler ──────────────────────────────────────────
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'embed_channel_select') return;

  const channelId = interaction.values[0];
  const data = pendingEmbeds.get(interaction.message.id);

  if (!data) {
    return interaction.reply({ content: '⚠️ Embed data not found — it may have expired.', ephemeral: true });
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased()) {
      return interaction.reply({ content: '⚠️ Selected channel is not a text channel.', ephemeral: true });
    }

    const embed = new EmbedBuilder(data.embedData);
    await channel.send({ embeds: [embed] });

    pendingEmbeds.delete(interaction.message.id);

    return interaction.reply({
      content: `✅ Embed sent to <#${channelId}>`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('Interaction handler error:', err);
    return interaction.reply({ content: `❌ Failed to send embed: ${err.message}`, ephemeral: true });
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot ready — logged in as ${client.user.tag}`);

  const deployCommand = new SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Fetch a webhook payload from a URL and send it as an embed to a channel')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('The URL to fetch the embed JSON payload from')
        .setRequired(true),
    );

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('🔄 Registering /deploy slash command...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [deployCommand.toJSON()],
    });
    console.log('✅ /deploy slash command registered globally.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server listening on port ${PORT}`);
});
