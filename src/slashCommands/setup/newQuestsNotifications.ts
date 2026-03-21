import {
    ChatInputCommandInteraction,
    OverwriteType,
    PermissionFlagsBits,
    SlashCommandChannelOption,
    TextChannel,
    ChannelType,
} from "discord.js";
import { SlashCommand, slashCommandFlags } from "../../lib/handler/slashCommand.js";
import { CustomClient } from "../../core/customClient.js";
import { permissionList } from "../../lib/handler/messageCommand.js";
import { I18nInstance } from "../../core/i18n.js";
import GuildDocument from "../../entities/guildSettings.js";
import { EmbedBuilder } from "../../lib/handler/embedBuilder.js";
import { saveNotificationChannel } from "../../core/configPersist.js";

export default class NewQuestsNotifications extends SlashCommand {
    public name = "newquestsnotifications";
    public description = "Set the notification channel for new quests and configure bot permissions";

    public options = [
        new SlashCommandChannelOption()
            .setName("channel")
            .setDescription("The channel to receive quest notifications")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
    ];

    public cooldown: number | string = "5s";
    public permissions: permissionList[] = [];
    public bot_permissions: permissionList[] = ["ManageChannels"];
    public flags: slashCommandFlags[] = ["onlyGuild", "ephemeral", "devOnly"];

    public async execute({
        interaction,
        i18n,
    }: {
        interaction: ChatInputCommandInteraction;
        client: CustomClient;
        i18n: I18nInstance;
        lang: string;
        guildConfig: GuildDocument | null;
    }): Promise<any> {
        const rawChannel = interaction.options.getChannel("channel", true);

        if (!rawChannel) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("newQuestsNotifications.invalidChannel"))
                        .setColor("DarkRed"),
                ],
            });
        }

        // Fetch the full channel object from guild to ensure it's not partial
        const guild = interaction.guild!;
        const channel = await guild.channels.fetch(rawChannel.id).catch(() => null) as TextChannel | null;

        if (
            !channel ||
            (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        ) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("newQuestsNotifications.invalidChannel"))
                        .setColor("DarkRed"),
                ],
            });
        }

        const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);

        if (!botMember) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("newQuestsNotifications.botMemberNotFound"))
                        .setColor("DarkRed"),
                ],
            });
        }

        const requiredPerms = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ManageMessages,
        ];

        const botPermsInChannel = channel.permissionsFor(botMember);
        const missingPerms = requiredPerms.filter(p => !botPermsInChannel?.has(p));

        if (missingPerms.length > 0) {
            const permNames = missingPerms
                .map(p => Object.entries(PermissionFlagsBits).find(([, v]) => v === p)?.[0] ?? p.toString())
                .join(", ");

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("newQuestsNotifications.missingPerms", { perms: permNames }))
                        .setColor("DarkRed"),
                ],
            });
        }

        try {
            await channel.permissionOverwrites.edit(
                botMember,
                {
                    ViewChannel: true,
                    SendMessages: true,
                    EmbedLinks: true,
                    AttachFiles: true,
                    MentionEveryone: false,
                    ManageMessages: true,
                },
                { type: OverwriteType.Member }
            );

            saveNotificationChannel(channel.id);

            const permList = [
                i18n.t("newQuestsNotifications.permViewChannel"),
                i18n.t("newQuestsNotifications.permSendMessages"),
                i18n.t("newQuestsNotifications.permEmbedLinks"),
                i18n.t("newQuestsNotifications.permAttachFiles"),
                i18n.t("newQuestsNotifications.permManageMessages"),
                i18n.t("newQuestsNotifications.permMentionEveryone"),
            ].join("\n");

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(i18n.t("newQuestsNotifications.channelSetTitle"))
                        .setDescription(
                            i18n.t("newQuestsNotifications.channelSetDesc", {
                                channel: channel.toString(),
                                perms: permList,
                            })
                        )
                        .setColor("Green")
                        .setFooter({ text: i18n.t("newQuestsNotifications.persistNote") }),
                ],
            });
        } catch (err: any) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            i18n.t("newQuestsNotifications.permissionsFailed", { error: err?.message ?? String(err) })
                        )
                        .setColor("DarkRed"),
                ],
            });
        }
    }
}
