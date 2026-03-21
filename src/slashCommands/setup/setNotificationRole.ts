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
import { saveNotificationRole } from "../../core/configPersist.js";

export default class SetNotificationRole extends SlashCommand {
    public name = "setnotificationrole";
    public description = "Set the role to be pinged for new quest notifications";

    public options = [
        new SlashCommandRoleOption()
            .setName("role")
            .setDescription("The role to ping when a new quest is available")
            .setRequired(true),
    ];

    public cooldown: number | string = "5s";
    public permissions: permissionList[] = [];
    public bot_permissions: permissionList[] = [];
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
        const role = interaction.options.getRole("role", true) as Role;

        if (!role) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("setNotificationRole.invalidRole"))
                        .setColor("#06c2fb"),
                ],
            });
        }

        const success = saveNotificationRole(role.id);

        if (!success) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(i18n.t("setNotificationRole.saveFailed"))
                        .setColor("#06c2fb"),
                ],
            });
        }

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle(i18n.t("setNotificationRole.title"))
                    .setDescription(
                        i18n.t("setNotificationRole.desc", { role: role.toString() })
                    )
                    .setColor("#06c2fb")
                    .setFooter({ text: i18n.t("setNotificationRole.persistNote") }),
            ],
        });
    }
}
