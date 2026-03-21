import { AttachmentBuilder, ClientEvents, Collection, Guild, GuildMember, Message, OverwriteType, Snowflake, TextChannel } from "discord.js";
import { baseDiscordEvent } from "../../lib/handler/baseClientEvent.js";
import cron from "node-cron";
import { Quest, RewardType } from "../../lib/quest/Quest.js";
import { User } from "../../lib/quest/User.js";
import questsConfig from "../../config/questsConfig.js";
import { getIdFromToken, isValidDiscordToken } from "../../utils/quest/tokenUtils.js";
import { questRepo, userSettingsRepo } from "../../core/cache.js";
import moment from "moment-timezone";
import { QuestConfig } from "../../lib/questConfig.js";
import { SelfUserQuestRunner } from "../../lib/quest/SelfUserQuestRunner.js";
import { loadFolder } from "../../handler/folderLoader.js";
import { findClosestIndexFolder } from "../../utils/tools.js";
import path from "path";
import sharp from "sharp";
import axios from "axios";

const token = questsConfig?.notification?.token;
const isValidToken = token && isValidDiscordToken(token) && getIdFromToken(token) !== null;
export const selfUser = isValidToken ? new User(token) : null;

/** Quest configs loaded from the quests folder (used by SelfUserQuestRunner) */
const questConfigs = new Collection<string, QuestConfig>();

/** Tracks quest IDs currently being completed to avoid duplicate runs */
const completingQuests = new Set<string>();

export default class readyEvent extends baseDiscordEvent {
    public name: keyof ClientEvents = "clientReady";
    public once: boolean = true;

    private async loadQuestConfigs(): Promise<void> {
        if (questConfigs.size > 0) return;
        const rootDir = findClosestIndexFolder();
        const questsFolder = path.join(rootDir, "quests");
        const quests = await loadFolder(questsFolder, {
            logger: false,
            shouldReturn: true,
            subFolders: true,
        }) as QuestConfig[];
        quests.forEach(q => questConfigs.set(q.name, q));
        this.logger.info(`SelfUser: loaded ${questConfigs.size} quest configs`);
    }

    private async checkQuest(quest: Quest) {
        const questDb = await quest.getDb();
        return questDb.messageSent ? null : questDb;
    }

    private async getGuildAndChannel(): Promise<{ guild: Guild; channel: TextChannel } | null> {
        const guild = this.client.guilds.cache.get(questsConfig.serverId)
            ?? await this.client.guilds.fetch(questsConfig.serverId).catch(() => null);

        if (!guild) {
            this.logger.warn("Bot is not in the specified server. Quest notifications disabled.");
            return null;
        }

        const channel = guild.channels.cache.get(questsConfig.notification.channel)
            ?? await guild.channels.fetch(questsConfig.notification.channel).catch(() => null);

        if (!channel?.isTextBased()) {
            this.logger.warn("Notification channel is invalid or not text-based. Quest notifications disabled.");
            return null;
        }

        return { guild, channel: channel as TextChannel };
    }

    private async setupChannelPermissions(channel: TextChannel): Promise<void> {
        try {
            const guild = channel.guild;
            const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
            if (!botMember) return;

            await channel.permissionOverwrites.edit(botMember, {
                ViewChannel: true,
                SendMessages: true,
                EmbedLinks: true,
                AttachFiles: true,
                MentionEveryone: false,
                ManageMessages: true,
            }, { type: OverwriteType.Member });

            this.logger.info(`[Permissions] Set on #${channel.name} (${channel.id}): ViewChannel ✓ SendMessages ✓ EmbedLinks ✓ AttachFiles ✓ ManageMessages ✓`);
        } catch (err) {
            this.logger.warn(`[Permissions] Failed to set permissions on channel: ${err}`);
        }
    }

    private async fetchMembersToDM(guild: Guild): Promise<Collection<Snowflake, GuildMember> | null> {
        const dmRoles = questsConfig?.notification?.dm?.dmRoles || [];
        if (!questsConfig.notification.dm?.enabled || dmRoles.length === 0) return null;

        const members = await guild.members.fetch().catch(() => null);
        if (!members) return null;

        const eligibleMembers = members.filter(
            member => !member.user.bot && dmRoles.some(r => member.roles.cache.has(r))
        );

        if (eligibleMembers.size === 0) return null;
        return eligibleMembers;
    }

    private async getUserSettings(id: string) {
        return userSettingsRepo.findOne({ where: { userId: id } }).catch(() => null);
    }

    /** Visual progress bar: ▓▓▓▓▓░░░░░ 50% */
    private buildProgressBar(percent: number): string {
        const filled = Math.round(percent / 10);
        const empty = 10 - filled;
        return `${"▓".repeat(filled)}${"░".repeat(empty)} ${percent}%`;
    }

    /**
     * Complete a quest on selfUser by running the QuestConfig directly in the
     * main process — completely bypasses child process and ChildManager limits.
     * Automatically retries on failure, resuming from last saved Discord progress.
     * Logs live progress to console on key events.
     */
    private async completeQuestOnSelfUser(quest: Quest): Promise<boolean> {
        if (!selfUser) return false;

        if (completingQuests.has(quest.id)) {
            this.logger.info(`Quest ${quest.id} is already being completed, skipping duplicate`);
            return false;
        }

        const MAX_RETRIES = 10;
        const RETRY_DELAY_MS = 3 * 60 * 1000; // 3 minutes between retries

        // Find the matching QuestConfig once (task name can't change)
        await selfUser.fetchQuests().catch(() => null);
        const firstQuest = selfUser.quests.get(quest.id) ?? quest;
        const taskName = firstQuest.solveMethod?.id;
        const questConfig = taskName ? questConfigs.get(taskName) : null;
        const questName = firstQuest.displayLabel ?? quest.id;

        if (!questConfig || !taskName) {
            this.logger.warn(`No quest config found for quest ${quest.id} (taskName="${taskName}") — skipping`);
            return false;
        }

        // Add to completingQuests NOW — stays until fully done or retries exhausted
        completingQuests.add(quest.id);

        let attempt = 0;

        try {
            while (attempt <= MAX_RETRIES) {
                // Re-fetch latest state from Discord before each attempt
                await selfUser.fetchQuests().catch(() => null);
                const latestQuest = selfUser.quests.get(quest.id) ?? quest;

                if (latestQuest.isCompleted()) {
                    this.logger.info(`Quest ${quest.id} already completed on selfUser ✓`);
                    return true;
                }

                // Enroll if needed
                if (!latestQuest.data?.user_status?.enrolled_at) {
                    const enrolled = await latestQuest.enroll();
                    if (!enrolled) {
                        this.logger.warn(`Quest ${quest.id}: enroll failed on attempt ${attempt + 1}, retrying...`);
                        attempt++;
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                        continue;
                    }
                    this.logger.info(`Quest ${quest.id}: SelfUser enrolled`);
                }

                // Resume from saved Discord progress
                const current = latestQuest.data?.user_status?.progress?.[taskName]?.value ?? 0;
                const target = latestQuest.solveMethod?.target ?? 0;
                const startPercent = target > 0 ? Math.min(100, Math.floor((current / target) * 100)) : 0;

                if (attempt === 0) {
                    this.logger.info(`[Quest] "${questName}" (${taskName}) | Started | ${this.buildProgressBar(startPercent)} (${current}/${target})`);
                } else {
                    this.logger.info(`[Quest] "${questName}" (${taskName}) | Retry ${attempt}/${MAX_RETRIES} | ${this.buildProgressBar(startPercent)} (${current}/${target})`);
                }

                const runner = new SelfUserQuestRunner(
                    selfUser.token,
                    selfUser.id,
                    quest.id,
                    questConfig,
                    current,
                    target
                );

                // Live progress updates → log + optional console
                runner.on("progress", ({ current: c, target: t, percent, completed: done }) => {
                    const bar = this.buildProgressBar(percent);
                    if (done) {
                        this.logger.info(`Quest ${quest.id} (${taskName}): ${bar} (${c}/${t}) — DONE ✓`);
                    } else {
                        this.logger.info(`Quest ${quest.id} (${taskName}): ${bar} (${c}/${t})`);
                    }
                });

                const success = await new Promise<boolean>((resolve) => {
                    runner.once("completed", () => resolve(true));
                    runner.once("failed", (reason: string) => {
                        this.logger.warn(`Quest ${quest.id} attempt ${attempt + 1} stopped: ${reason}`);
                        resolve(false);
                    });
                    runner.run().catch(() => resolve(false));
                });

                // Remove progress listener to avoid memory leaks on retry
                runner.removeAllListeners("progress");

                if (success) {
                    this.logger.info(`[Quest] "${questName}" (${taskName}) | ✓ Completed! | ${this.buildProgressBar(100)} (${target}/${target})`);
                    return true;
                }

                attempt++;
                if (attempt <= MAX_RETRIES) {
                    const waitMin = RETRY_DELAY_MS / 60000;
                    this.logger.info(`Quest ${quest.id}: waiting ${waitMin} min before retry ${attempt}/${MAX_RETRIES}...`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                }
            }

            this.logger.warn(`[Quest] "${questName}" (${taskName}) | ✗ Failed after ${MAX_RETRIES} retries`);
            return false;

        } finally {
            completingQuests.delete(quest.id);
        }
    }

    /**
     * Kick off completion for ALL available (non-completed) quests on selfUser.
     * Runs in the background — does NOT block the cron or startup.
     */
    private startAutoCompleteAll(): void {
        if (!selfUser) return;

        for (const [, quest] of selfUser.quests) {
            if (quest.isCompleted()) continue;
            if (completingQuests.has(quest.id)) continue;

            const taskName = quest.solveMethod?.id;
            if (!taskName || !questConfigs.has(taskName)) continue; // only supported quests

            this.logger.info(`Auto-queuing quest ${quest.id} (${taskName}) for selfUser completion`);
            this.completeQuestOnSelfUser(quest).catch(() => null);
        }
    }

    /** Build composite: selfUser's circular avatar + decoration overlay */
    private async buildAvatarWithDecoration(decorationBuffer: Buffer): Promise<Buffer | null> {
        if (!selfUser) return null;
        try {
            const { data } = await selfUser.api.get("/users/@me");
            const avatarHash = data?.avatar;
            if (!avatarHash) return null;

            const ext = avatarHash.startsWith("a_") ? "gif" : "png";
            const avatarUrl = `https://cdn.discordapp.com/avatars/${selfUser.id}/${avatarHash}.${ext}?size=512`;

            const avatarResp = await axios.get(avatarUrl, { responseType: "arraybuffer", timeout: 10000 });
            let avatarBuffer = Buffer.from(avatarResp.data);

            if (ext === "gif") {
                avatarBuffer = await sharp(avatarBuffer, { animated: false, pages: 1 }).png().toBuffer();
            }

            const size = 512;
            const circularMask = Buffer.from(
                `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`
            );

            const circularAvatar = await sharp(avatarBuffer)
                .resize(size, size, { fit: "cover" })
                .composite([{ input: circularMask, blend: "dest-in" }])
                .png()
                .toBuffer();

            const resizedDecoration = await sharp(decorationBuffer)
                .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();

            return await sharp(circularAvatar)
                .composite([{ input: resizedDecoration, blend: "over" }])
                .png()
                .toBuffer();
        } catch (err) {
            this.logger.error("Failed to build avatar+decoration composite:", err);
            return null;
        }
    }

    private async getNotificationThumbnail(quest: Quest, selfCompleted: boolean): Promise<Buffer | null> {
        const reward = quest.rewards?.[0];
        if (reward?.type !== RewardType.DiscordDecorations) return null;

        const decorationBuffer = selfUser ? await selfUser.loadQuestDecoration(quest) : null;
        if (!decorationBuffer) return null;

        if (!selfCompleted) {
            this.logger.info(`Exception case for quest ${quest.id}: decoration only (no avatar)`);
            return decorationBuffer;
        }

        const composite = await this.buildAvatarWithDecoration(decorationBuffer);
        return composite ?? decorationBuffer;
    }

    private async sendQuestNotification(
        quest: Quest,
        questDoc: any,
        channel: TextChannel,
        members: Collection<Snowflake, GuildMember> | null,
        thumbnailBuffer: Buffer | null
    ) {
        const messageContent = await quest.notification_message();
        const payload: any = { ...messageContent };

        if (thumbnailBuffer) {
            const fileName = "quest_thumbnail.png";
            payload.files = [...(payload.files || []), new AttachmentBuilder(thumbnailBuffer, { name: fileName })];
            if (payload.embeds?.[0]?.data) {
                payload.embeds[0].data.thumbnail = { url: `attachment://${fileName}` };
            }
        }

        const channelMessage: Message = await channel.send(payload)
            .then(async (msg) => {
                this.logger.info(`Sent notification for quest ${quest.id}`);
                questDoc.messageSent = true;
                await questRepo.save(questDoc);
                return msg;
            })
            .catch((err) => {
                this.logger.warn(`Failed to send notification for quest ${quest.id}: ${err}`);
                return null;
            });

        if (channelMessage) channelMessage.crosspost().catch(() => null);

        if (!members?.size) return;

        for (const member of members.values()) {
            const userSettings = await this.getUserSettings(member.id);
            const lang = userSettings?.lang ?? this?.client?.config?.defaultLanguage ?? "en";
            const i18n = this.i18n.get(lang);
            const userMessage: any = await quest.notification_message(i18n);

            if (thumbnailBuffer) {
                const fileName = "quest_thumbnail.png";
                userMessage.files = [...(userMessage.files || []),
                    new AttachmentBuilder(thumbnailBuffer, { name: fileName })];
                if (userMessage.embeds?.[0]?.data) {
                    userMessage.embeds[0].data.thumbnail = { url: `attachment://${fileName}` };
                }
            }

            member.send({ ...userMessage, content: `${member.toString()}` }).catch(() => null);
        }
    }

    async executeEvent(): Promise<void> {
        if (!selfUser) {
            this.logger.warn("Invalid or missing QUEST_CONFIG_TOKEN. Quest notifications disabled.");
            return;
        }

        // Load quest configs once (needed by SelfUserQuestRunner)
        await this.loadQuestConfigs();

        // ── Initial fetch & auto-complete on startup ──────────────────────
        this.logger.info("SelfUser: fetching quests on startup...");
        await selfUser.fetchQuests().catch(() => null);
        this.startAutoCompleteAll();

        // ── Cron: every 5 minutes ─────────────────────────────────────────
        cron.schedule("0 */5 * * * *", async () => {
            this.logger.info("Checking for new quests...");

            const oldQuests = new Collection<string, Quest>();
            selfUser.quests.forEach(q => oldQuests.set(q.id, q));

            const newQuests = await selfUser.fetchQuests().catch(() => null);
            if (!newQuests) return;

            // Always try to complete any unfinished quests (runs in background)
            this.startAutoCompleteAll();

            // ── Notification handling ────────────────────────────────────
            const guildAndChannel = await this.getGuildAndChannel();
            if (!guildAndChannel) return;
            const { guild, channel } = guildAndChannel;

            await this.setupChannelPermissions(channel);

            const diff = newQuests.filter(q =>
                !oldQuests.has(q.id) &&
                moment(q.startsAt).isAfter(moment().subtract(6, "hours"))
            );

            if (!diff.size) return;

            const members = await this.fetchMembersToDM(guild);
            const unSentQuests = await Promise.all(diff.map(q => this.checkQuest(q)));
            const filteredQuests = unSentQuests.filter(q => q !== null);

            for (const questDoc of filteredQuests) {
                const quest = newQuests.get(questDoc.questId);
                if (!quest) continue;

                const isDecorationQuest = quest.rewards?.[0]?.type === RewardType.DiscordDecorations;

                let selfCompleted = quest.isCompleted();
                if (!selfCompleted) {
                    this.logger.info(`Waiting for selfUser to complete quest ${quest.id} before notifying...`);
                    selfCompleted = await this.completeQuestOnSelfUser(quest);
                }

                const thumbnailBuffer = isDecorationQuest
                    ? await this.getNotificationThumbnail(quest, selfCompleted)
                    : null;

                await this.sendQuestNotification(quest, questDoc, channel, members, thumbnailBuffer);
            }
        });
    }
}
