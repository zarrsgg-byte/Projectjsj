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
import questsConfig from "../../config/questsConfig.js";
import { saveConfigOverride } from "../../core/configPersist.js";

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
    }: {
        interaction: ChatInputCommandInteraction;
        client: CustomClient;
        i18n: I18nInstance;
        lang: string;
        guildConfig: GuildDocument | null;
    }): Promise<any> {
        const channel = interaction.options.getChannel("channel", true);

        if (!channel || !(channel instanceof TextChannel)) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription("❌ **Invalid channel. Please select a valid text channel.**")
                        .setColor("DarkRed"),
                ],
            });
        }

        const guild = interaction.guild!;
        const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);

        if (!botMember) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription("❌ **Could not retrieve bot member information.**")
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
                        .setDescription(
                            `❌ **The bot lacks permission to edit overwrites in that channel.**\n-# Missing: \`${permNames}\``
                        )
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

            questsConfig.notification.channel = channel.id;
            saveConfigOverride({ notificationChannel: channel.id });

            const permList = [
                "✅ **ViewChannel** — View the channel",
                "✅ **SendMessages** — Send messages",
                "✅ **EmbedLinks** — Embed links",
                "✅ **AttachFiles** — Attach files & images",
                "✅ **ManageMessages** — Manage messages",
                "❌ **MentionEveryone** — Mention everyone (disabled)",
            ].join("\n");

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🔔 Notification Channel Set")
                        .setDescription(
                            `${channel} has been set as the quest notification channel.\n\n**Bot permission overwrites applied:**\n${permList}`
                        )
                        .setColor("Green")
                        .setFooter({ text: "This setting is saved and will persist across restarts." }),
                ],
            });
        } catch (err: any) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`❌ **Failed to apply permission overwrites:**\n\`\`\`${err?.message ?? err}\`\`\``)
                        .setColor("DarkRed"),
                ],
            });
        }
    }
}
