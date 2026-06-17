const {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

// Stores parsed embed payloads keyed by a unique pending key so the modal
// submit handler can retrieve them after the user types a channel name.
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
    const { guildId, embedData, channelName } = req.body;

    if (!guildId || !embedData) {
      return res.status(400).json({ error: 'guildId and embedData are required' });
    }

    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required — provide the name of the channel to send the embed to' });
    }

    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const textChannels = channels.filter((ch) => ch?.type === ChannelType.GuildText);

    if (textChannels.size === 0) {
      return res.status(400).json({ error: 'No text channels found in this guild' });
    }

    const normalised = channelName.trim().toLowerCase().replace(/^#/, '');
    const matches = textChannels.filter((ch) => ch.name.toLowerCase().includes(normalised));

    if (matches.size === 0) {
      return res.status(404).json({ error: `No text channel found matching "${normalised}"` });
    }

    if (matches.size > 1) {
      const names = matches.map((ch) => `#${ch.name}`).join(', ');
      return res.status(400).json({ error: `Multiple channels match "${normalised}": ${names}. Please be more specific.` });
    }

    const targetChannel = matches.first();
    const messages = normalisePayload(embedData);

    for (const msgPayload of messages) {
      const sendOptions = {};

      if (msgPayload.content) {
        sendOptions.content = msgPayload.content;
      }

      if (msgPayload.embeds && msgPayload.embeds.length > 0) {
        sendOptions.embeds = msgPayload.embeds.map((e) => new EmbedBuilder(e));
      }

      if (!sendOptions.content && !sendOptions.embeds) continue;

      await targetChannel.send(sendOptions);
    }

    return res.json({ success: true, channelId: targetChannel.id, channelName: targetChannel.name, messageCount: messages.length });
  } catch (err) {
    console.error('POST /webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

client.on('interactionCreate', async (interaction) => {
  // ── /deploy slash command ────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
    const input = interaction.options.getString('url', true).trim();

    // We cannot defer here because showModal must be the first (and only)
    // response to the interaction. Parse/fetch the JSON first, then show
    // the modal — all within Discord's 3-second acknowledgement window.
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
        return interaction.reply({
          content: '❌ Invalid URL. Please provide a valid `http` or `https` URL.',
          ephemeral: true,
        });
      }

      // ── Direct JSON URL ──────────────────────────────────────────────────
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return interaction.reply({
            content: `❌ Failed to fetch URL — server responded with \`${response.status} ${response.statusText}\`.`,
            ephemeral: true,
          });
        }
        const json = await response.json();
        messages = normalisePayload(json);
      } catch (err) {
        console.error('/deploy fetch error:', err);
        return interaction.reply({
          content: `❌ Could not fetch or parse JSON from the URL: ${err.message}`,
          ephemeral: true,
        });
      }
    } else {
      // ── Raw JSON: parse the pasted text directly ─────────────────────────
      let json;
      try {
        json = JSON.parse(input);
      } catch {
        return interaction.reply({
          content: '❌ Input is not a valid URL and could not be parsed as JSON. Please provide a URL that returns JSON or paste raw JSON directly.',
          ephemeral: true,
        });
      }
      messages = normalisePayload(json);
    }

    if (!messages || messages.length === 0) {
      return interaction.reply({ content: '❌ No message data found in the provided input.', ephemeral: true });
    }

    // Store the parsed messages keyed by a unique ID so the modal submit
    // handler can retrieve them after the user types a channel name.
    const pendingKey = `${interaction.user.id}_${Date.now()}`;
    pendingEmbeds.set(pendingKey, { messages, guildId: interaction.guild.id });

    // Build a modal with a single text input for the channel name.
    const modal = new ModalBuilder()
      .setCustomId(`channel_modal:${pendingKey}`)
      .setTitle('Choose a Channel');

    const channelInput = new TextInputBuilder()
      .setCustomId('channel_name')
      .setLabel('Channel name (e.g. general, announcements)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('general')
      .setMinLength(1)
      .setMaxLength(100)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(channelInput));

    // showModal is the interaction response — no defer/reply before this.
    return interaction.showModal(modal);
  }

  // ── Modal submit: channel name typed by the user ─────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('channel_modal:')) {
    const pendingKey = interaction.customId.slice('channel_modal:'.length);
    const data = pendingEmbeds.get(pendingKey);

    if (!data) {
      return interaction.reply({ content: '⚠️ Embed data not found — it may have expired. Please run `/deploy` again.', ephemeral: true });
    }

    const rawName = interaction.fields.getTextInputValue('channel_name').trim().toLowerCase().replace(/^#/, '');

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = await client.guilds.fetch(data.guildId);
      const channels = await guild.channels.fetch();
      const textChannels = channels.filter((ch) => ch?.type === ChannelType.GuildText);

      // Find channels whose name contains the typed string (case-insensitive).
      const matches = textChannels.filter((ch) => ch.name.toLowerCase().includes(rawName));

      if (matches.size === 0) {
        return interaction.editReply({
          content: `❌ No text channel found matching **"${rawName}"**. Check the name and try again.`,
        });
      }

      if (matches.size > 1) {
        const list = matches.map((ch) => `• #${ch.name}`).join('\n');
        return interaction.editReply({
          content: `⚠️ Multiple channels match **"${rawName}"**. Please be more specific:\n${list}`,
        });
      }

      const channel = matches.first();

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

      pendingEmbeds.delete(pendingKey);

      const count = data.messages.length;
      const messageWord = count === 1 ? 'message' : 'messages';

      return interaction.editReply({
        content: `✅ Sent **${count} ${messageWord}** to <#${channel.id}>`,
      });
    } catch (err) {
      console.error('Modal submit handler error:', err);
      return interaction.editReply({ content: `❌ Failed to send embed: ${err.message}` });
    }
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
