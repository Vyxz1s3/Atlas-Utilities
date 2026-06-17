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

/**
 * Normalises a parsed JSON object into an array of { embeds, content }
 * message payloads regardless of whether it came from a webhook export
 * (with a top-level `messages` array) or is a flat embed/payload object.
 *
 * @param {object} json
 * @returns {{ embeds: object[], content: string|undefined }[]}
 */
function normalisePayload(json) {
  if (Array.isArray(json.messages)) {
    return json.messages.map((msg) => {
      const d = msg.data ?? msg;
      return {
        embeds: Array.isArray(d.embeds) ? d.embeds : [],
        content: d.content ?? undefined,
      };
    });
  }
  // Flat object — treat as a single message payload.
  return [{ embeds: Array.isArray(json.embeds) ? json.embeds : [json], content: json.content ?? undefined }];
}


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
    const messages = normalisePayload(embedData);
    pendingEmbeds.set(msg.id, { messages, guildId });

    return res.json({ success: true, messageId: msg.id });
  } catch (err) {
    console.error('POST /webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

client.on('interactionCreate', async (interaction) => {
  // ── /deploy slash command ────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
    const input = interaction.options.getString('url', true).trim();

    await interaction.deferReply({ ephemeral: true });

    let messages;

    // Determine whether the input is a URL or raw JSON text.
    const looksLikeUrl = /^https?:\/\//i.test(input);

    if (looksLikeUrl) {
      // ── URL: parse and validate ───────────────────────────────────────────
      let url;
      try {
        url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        return interaction.editReply({ content: '❌ Invalid URL. Please provide a valid `http` or `https` URL.' });
      }

      // ── Direct JSON URL ──────────────────────────────────────────────────
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return interaction.editReply({
            content: `❌ Failed to fetch URL — server responded with \`${response.status} ${response.statusText}\`.`,
          });
        }
        const json = await response.json();
        messages = normalisePayload(json);
      } catch (err) {
        console.error('/deploy fetch error:', err);
        return interaction.editReply({ content: `❌ Could not fetch or parse JSON from the URL: ${err.message}` });
      }
    } else {
      // ── Raw JSON: parse the pasted text directly ─────────────────────────
      let json;
      try {
        json = JSON.parse(input);
      } catch (err) {
        return interaction.editReply({
          content: '❌ Input is not a valid URL and could not be parsed as JSON. Please provide a URL that returns JSON or paste raw JSON directly.',
        });
      }
      messages = normalisePayload(json);
    }

    if (!messages || messages.length === 0) {
      return interaction.editReply({ content: '❌ No message data found in the provided input.' });
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

    const messageWord = messages.length === 1 ? 'message' : 'messages';

    const promptEmbed = new EmbedBuilder()
      .setTitle('Select a Channel')
      .setDescription(
        `Loaded **${messages.length} ${messageWord}**.\n` +
        'Choose the channel where the embed(s) should be sent.',
      )
      .setColor(0x0099ff);

    // Send the picker as a follow-up so we have a stable message ID to key on.
    const msg = await interaction.followUp({
      embeds: [promptEmbed],
      components: [row],
      ephemeral: true,
    });

    pendingEmbeds.set(msg.id, { messages, guildId: guild.id });
    return;
  }


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

    // Send every message from the payload in order.
    for (const msgPayload of data.messages) {
      const sendOptions = {};

      if (msgPayload.content) {
        sendOptions.content = msgPayload.content;
      }

      if (msgPayload.embeds && msgPayload.embeds.length > 0) {
        sendOptions.embeds = msgPayload.embeds.map((e) => new EmbedBuilder(e));
      }

      // Skip empty messages (no content and no embeds).
      if (!sendOptions.content && !sendOptions.embeds) continue;

      await channel.send(sendOptions);
    }

    pendingEmbeds.delete(interaction.message.id);

    const count = data.messages.length;
    const messageWord = count === 1 ? 'message' : 'messages';

    return interaction.reply({
      content: `✅ Sent **${count} ${messageWord}** to <#${channelId}>`,
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
    .setDescription('Deploy a webhook embed payload from raw JSON or a direct JSON URL')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('Raw JSON or a URL that returns JSON embed data')
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
