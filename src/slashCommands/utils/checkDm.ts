import { ChatInputCommandInteraction, SlashCommandUserOption } from "discord.js";
import { SlashCommand, slashCommandFlags } from "../../lib/handler/slashCommand.js";
import { CustomClient } from "../../core/customClient.js";
import { permissionList } from "../../lib/handler/messageCommand.js";
import { I18nInstance } from "../../core/i18n.js";
import GuildDocument from "../../entities/guildSettings.js";
import { EmbedBuilder } from "../../lib/handler/embedBuilder.js";

export default class CheckDm extends SlashCommand {
    public name = "check-dm";
    public description = "Sends a test DM to verify direct messages are open";
    public options = [
        new SlashCommandUserOption()
            .setName("user")
            .setDescription("The user to send the DM check to (defaults to you)")
            .setRequired(false),
    ];
    public cooldown: number | string = "30s";
    public permissions: permissionList[] = [];
    public bot_permissions: permissionList[] = [];
    public flags: slashCommandFlags[] = ["ephemeral"];

    public async execute({
        interaction,
    }: {
        interaction: ChatInputCommandInteraction;
        client: CustomClient;
        i18n: I18nInstance;
        lang: string;
        guildConfig: GuildDocument | null;
    }): Promise<any> {
        const target = interaction.options.getUser("user") ?? interaction.user;
        const isSelf = target.id === interaction.user.id;

        const dmEmbed = new EmbedBuilder()
            .setTitle("✅ DM Check")
            .setDescription(`Your direct messages are **open**. ${target.toString()}`)
            .setColor("Green")
            .setTimestamp();

        const sent = await target.send({ embeds: [dmEmbed] }).catch(() => null);

        if (sent) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            isSelf
                                ? "✅ **Your DMs are open!**\n-# Check your direct messages — a test message was sent to you."
                                : `✅ **${target.toString()}'s DMs are open!**\n-# A test message was sent to them.`
                        )
                        .setColor("Green"),
                ],
            });
        }

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        isSelf
                            ? "❌ **Your DMs are closed.**\n-# To receive notifications, go to **Server Settings → Privacy Settings** and enable **Direct Messages**."
                            : `❌ **${target.toString()}'s DMs are closed.**\n-# They need to enable **Direct Messages** in their Server Privacy Settings.`
                    )
                    .setColor("DarkRed"),
            ],
        });
    }
}
