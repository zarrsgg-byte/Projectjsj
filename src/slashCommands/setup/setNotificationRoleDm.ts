import {
    ChatInputCommandInteraction,
    Role,
    SlashCommandRoleOption,
} from "discord.js";
import { SlashCommand, slashCommandFlags } from "../../lib/handler/slashCommand.js";
import { CustomClient } from "../../core/customClient.js";
import { permissionList } from "../../lib/handler/messageCommand.js";
import { I18nInstance } from "../../core/i18n.js";
import GuildDocument from "../../entities/guildSettings.js";
import { EmbedBuilder } from "../../lib/handler/embedBuilder.js";
import { saveNotificationDmRole } from "../../core/configPersist.js";
import questsConfig from "../../config/questsConfig.js";

export default class SetNotificationRoleDm extends SlashCommand {
    public name = "setnotificationroledm";
    public description = "Set a role to receive quest notifications via DM";

    public options = [
        new SlashCommandRoleOption()
            .setName("role")
            .setDescription("The role whose members will receive quest notifications via DM")
            .setRequired(true),
    ];

    public cooldown: number | string = "5s";
    public permissions: permissionList[] = [];
    public bot_permissions: permissionList[] = [];
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
        const role = interaction.options.getRole("role", true) as Role;

        if (!role) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription("❌ Invalid role.")
                        .setColor("#06c2fb"),
                ],
            });
        }

        const success = saveNotificationDmRole(role.id);
        if (!success) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription("❌ Failed to save the DM notification role.")
                        .setColor("#06c2fb"),
                ],
            });
        }

        const currentRoles = questsConfig.notification.dm.dmRoles;

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle("📩 DM Notification Role Set")
                    .setDescription(
                        `The role ${role.toString()} has been **added** to DM quest notifications.\n\n` +
                        `**Current DM roles:** ${currentRoles.map(id => `<@&${id}>`).join(", ") || "None"}`
                    )
                    .setColor("#06c2fb")
                    .setFooter({ text: "Members with this role will receive quest notifications via DM." }),
            ],
        });
    }
}
