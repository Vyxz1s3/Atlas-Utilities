client.on('guildMemberAdd', member => {
    const channel = member.guild.channels.cache.get('YOUR_CHANNEL_ID');

    if (!channel) return;

    channel.send(`Welcome ${member} to the server! 🎉`);
});
