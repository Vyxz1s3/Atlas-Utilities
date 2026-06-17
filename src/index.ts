import { Client, GatewayIntentBits, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder, ChannelType } from 'discord.js';
import express from 'express';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const app = express();

app.use(express.json());

const pendingEmbeds = new Map();

app.post('/webhook', async (req, res) => {
  const { guildId, embedData } = req.body;
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const textChannels = channels.filter(ch => ch?.type === ChannelType.GuildText);

  if (textChannels.size === 0) {
    return res.status(400).json({ error: 'No text channels found' });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('embed_channel_select')
    .setPlaceholder('Select a channel')
    .addOptions(
      textChannels.map(ch => ({
        label: ch!.name,
        value: ch!.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  const embed = new EmbedBuilder()
    .setTitle('Select Channel')
    .setDescription('Choose where to send the embed')
    .setColor(0x0099ff);

  const msg = await guild.systemChannel?.send({ embeds: [embed], components: [row] });
  if (msg) pendingEmbeds.set(msg.id, { embedData, guildId });

  res.json({ success: true, messageId: msg?.id });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  if (interaction.customId === 'embed_channel_select') {
    const channelId = interaction.values[0];
    const data = pendingEmbeds.get(interaction.message.id);

    if (!data) {
      return interaction.reply({ content: 'Embed data not found', ephemeral: true });
    }

    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder(data.embedData);
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: `✓ Embed sent to <#${channelId}>`, ephemeral: true });
      pendingEmbeds.delete(interaction.message.id);
    }
  }
});

client.on('ready', () => console.log(`✓ Bot ready as ${client.user?.tag}`));
client.login(process.env.DISCORD_TOKEN);

app.listen(3000, () => console.log('Webhook server on :3000'));