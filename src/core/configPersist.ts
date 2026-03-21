import fs from "fs";
import path from "path";
import questsConfig from "../config/questsConfig.js";
import { Logger } from "./logger.js";

const QUESTS_CONFIG_PATH = path.resolve("src/config/questsConfig.ts");

function updateNotificationField(field: string, newValue: string): boolean {
    try {
        let content = fs.readFileSync(QUESTS_CONFIG_PATH, "utf-8");

        const notifBlock = content.match(/notification\s*:\s*\{[\s\S]*?\}/);
        if (!notifBlock) {
            Logger.warn(`configPersist: could not find notification block in questsConfig.ts`);
            return false;
        }

        const updatedBlock = notifBlock[0].replace(
            new RegExp(`(${field}\\s*:\\s*)"[^"]*"`),
            `$1"${newValue}"`
        );

        content = content.replace(notifBlock[0], updatedBlock);
        fs.writeFileSync(QUESTS_CONFIG_PATH, content, "utf-8");

        Logger.info(`configPersist: notification.${field} updated to "${newValue}" in questsConfig.ts`);
        return true;
    } catch (err) {
        Logger.error(`configPersist: failed to update notification.${field} in questsConfig.ts:`, err);
        return false;
    }
}

export function saveNotificationChannel(channelId: string): boolean {
    questsConfig.notification.channel = channelId;
    return updateNotificationField("channel", channelId);
}

export function saveNotificationRole(roleId: string): boolean {
    questsConfig.notification.role = roleId;
    return updateNotificationField("role", roleId);
}

export function saveNotificationDmRole(roleId: string): boolean {
    try {
        questsConfig.notification.dm.dmRoles = [roleId];
        questsConfig.notification.dm.enabled = true;

        let content = fs.readFileSync(QUESTS_CONFIG_PATH, "utf-8");
        const rolesArray = JSON.stringify(questsConfig.notification.dm.dmRoles);
        content = content.replace(
            /dmRoles\s*:\s*\[.*?\]/s,
            `dmRoles: ${rolesArray}`
        );
        content = content.replace(
            /enabled\s*:\s*(true|false)/,
            `enabled: true`
        );
        fs.writeFileSync(QUESTS_CONFIG_PATH, content, "utf-8");
        Logger.info(`configPersist: notification.dm.dmRoles updated to ${rolesArray}`);
        return true;
    } catch (err) {
        Logger.error(`configPersist: failed to update notification.dm.dmRoles:`, err);
        return false;
    }
}

export function removeNotificationDmRole(roleId: string): boolean {
    try {
        questsConfig.notification.dm.dmRoles = questsConfig.notification.dm.dmRoles.filter(id => id !== roleId);

        let content = fs.readFileSync(QUESTS_CONFIG_PATH, "utf-8");
        const rolesArray = JSON.stringify(questsConfig.notification.dm.dmRoles);
        content = content.replace(
            /dmRoles\s*:\s*\[.*?\]/s,
            `dmRoles: ${rolesArray}`
        );
        fs.writeFileSync(QUESTS_CONFIG_PATH, content, "utf-8");
        Logger.info(`configPersist: role ${roleId} removed from notification.dm.dmRoles`);
        return true;
    } catch (err) {
        Logger.error(`configPersist: failed to remove role from notification.dm.dmRoles:`, err);
        return false;
    }
}
