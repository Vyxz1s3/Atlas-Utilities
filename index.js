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
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const app = express();
app.use(express.json());

// Stores embedData keyed by the selector message ID so the interaction
// handler can retrieve it when the user picks a channel.
const pendingEmbeds = new Map();

/**
 * Detects whether a URL is a discohook.app share link.
 * Matches both https://discohook.app/?share=<id> and
 * https://discohook.app/share/<id> style links.
 *
 * @param {URL} parsedUrl
 * @returns {string|null} The share ID, or null if not a discohook share link.
 */
function extractDiscohookShareId(parsedUrl) {
  if (!parsedUrl.hostname.endsWith('discohook.app')) return null;

  // ?share=<id> query-param style (most common)
  const shareParam = parsedUrl.searchParams.get('share');
  if (shareParam) return shareParam;

  // /share/<id> path style
  const pathMatch = parsedUrl.pathname.match(/^\/share\/([A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];

  return null;
}

/**
 * Resolves a discohook share ID to an array of embed objects ready to be
 * passed to EmbedBuilder.
 *
 * Discohook's share API returns a JSON envelope:
 *   { data: "<base64url-encoded, zlib-deflate-compressed JSON>" }
 *
 * The inner JSON has the shape:
 *   { messages: [{ data: { embeds: [...], content: "..." } }] }
 *
 * @param {string} shareId
 * @returns {Promise<{ embeds: object[], content: string|undefined }[]>} Array of message payloads.
 */
async function resolveDiscohookShare(shareId) {
  const apiUrl = `https://share.discohook.app/go/${shareId}`;
  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(`Discohook share API responded with \`${response.status} ${response.statusText}\`. The share link may be invalid or expired.`);
  }

  const envelope = await response.json();

  if (!envelope.data) {
    throw new Error('Unexpected response from discohook share API — missing `data` field.');
  }

  // The `data` field is base64url-encoded, zlib-deflate-compressed JSON.
  // base64url uses '-' and '_' instead of '+' and '/'.
  const base64 = envelope.data.replace(/-/g, '+').replace(/_/g, '/');
  const compressed = Buffer.from(base64, 'base64');

  let decompressed;
  try {
    decompressed = await inflateRaw(compressed);
  } catch {
    // Some share links store plain (uncompressed) base64 JSON — fall back.
    decompressed = compressed;
  }

  let parsed;
  try {
    parsed = JSON.parse(decompressed.toString('utf8'));
  } catch {
    throw new Error('Could not parse the discohook share payload as JSON.');
  }

  // Normalise to an array of message payloads.
  const messages = parsed.messages ?? parsed.backups?.[0]?.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('No messages found in the discohook share payload.');
  }

  return messages.map((msg) => {
    // Each message may nest its data under a `data` key or be flat.
    const msgData = msg.data ?? msg;
    return {
      embeds: Array.isArray(msgData.embeds) ? msgData.embeds : [],
      content: msgData.content ?? undefined,
    };
  });
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
    // Normalise embedData into the messages array format used by the interaction handler.
    const messages = Array.isArray(embedData.messages)
      ? embedData.messages.map((m) => { const d = m.data ?? m; return { embeds: Array.isArray(d.embeds) ? d.embeds : [], content: d.content ?? undefined }; })
      : [{ embeds: Array.isArray(embedData.embeds) ? embedData.embeds : [embedData], content: embedData.content ?? undefined }];
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

    // Resolve the payload — discohook share links need special handling.
    // `messages` is an array of { embeds, content } objects; for direct JSON
    // URLs we normalise the single response into the same shape.
    let messages;
    const shareId = extractDiscohookShareId(parsedUrl);

    if (shareId) {
      // ── Discohook share link ─────────────────────────────────────────────
      try {
        messages = await resolveDiscohookShare(shareId);
      } catch (err) {
        console.error('/deploy discohook resolve error:', err);
        return interaction.editReply({ content: `❌ Could not resolve discohook share link: ${err.message}` });
      }
    } else {
      // ── Direct JSON URL ──────────────────────────────────────────────────
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return interaction.editReply({ content: `❌ Failed to fetch URL — server responded with \`${response.status} ${response.statusText}\`.` });
        }
        const json = await response.json();
        // Normalise: if the JSON already has a `messages` array (discohook
        // export format) use it; otherwise treat the whole object as a single
        // embed payload.
        if (Array.isArray(json.messages)) {
          messages = json.messages.map((msg) => {
            const msgData = msg.data ?? msg;
            return {
              embeds: Array.isArray(msgData.embeds) ? msgData.embeds : [],
              content: msgData.content ?? undefined,
            };
          });
        } else {
          messages = [{ embeds: Array.isArray(json.embeds) ? json.embeds : [json], content: json.content ?? undefined }];
        }
      } catch (err) {
        console.error('/deploy fetch error:', err);
        return interaction.editReply({ content: `❌ Could not fetch or parse the URL: ${err.message}` });
      }
    }

    if (!messages || messages.length === 0) {
      return interaction.editReply({ content: '❌ No message data found at the provided URL.' });
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

    const sourceLabel = shareId
      ? `discohook share \`${shareId}\``
      : 'the provided URL';
    const messageWord = messages.length === 1 ? 'message' : 'messages';

    const promptEmbed = new EmbedBuilder()
      .setTitle('Select a Channel')
      .setDescription(
        `Loaded **${messages.length} ${messageWord}** from ${sourceLabel}.\n` +
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
    .setDescription('Deploy a webhook payload from a discohook.app share link or a direct JSON URL')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('A discohook.app share link (e.g. https://discohook.app/?share=…) or a direct JSON URL')
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
