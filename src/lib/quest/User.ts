import { AxiosInstance } from 'axios';
import axios from 'axios';
import sharp from 'sharp';
import { EventEmitter } from 'events';
import { customAxiosWithProxy } from '../../utils/quest/axiosInstance.js';

import { ProxyInterface } from '../../utils/loadProxy.js';
import { Quest, RewardType } from './Quest.js';
import { usersCache } from '../../core/cache.js';
import { getIdFromToken, isValidDiscordToken } from '../../utils/quest/tokenUtils.js';
import { I18nInstance } from '../../core/i18n.js';
import { i18n } from '../../providers/i18n.js';
import config from '../../config/config.js';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Collection, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import moment from 'moment-timezone';
import client from '../../providers/client.js';
import { formatDiscordTimestamp } from '../../utils/tools.js';
import { ChildProcess } from 'child_process';
import { ChildMessage } from '../../interface/ChildMessage.js';
import { Logger } from '../../core/logger.js';
import questsConfig from '../../config/questsConfig.js';
import { User as discordUser } from "discord.js";
import { CustomClient } from '../../interface/CustomClient.js';

// Per-sku_id cache so we only probe each decoration once per bot session.
const decorationAssetCache = new Map<string, string | null>();

/**
 * Returns the avatar-decoration-presets asset hash (e.g. "a_abc123") for a given
 * decoration sku_id, trying sources in priority order:
 *   1. Manual config entry in questsConfig.customDecorationAssets
 *   2. Discord store published-listing API probe (logs full response for debugging)
 */
async function lookupDecorationAsset(api: AxiosInstance, skuId: string): Promise<string | null> {
    if (decorationAssetCache.has(skuId)) return decorationAssetCache.get(skuId) ?? null;

    // 1. Manual override in config — fastest path, always wins
    const configAsset = questsConfig.customDecorationAssets?.[skuId];
    if (configAsset) {
        Logger.info(`Decoration asset for sku ${skuId} resolved from config: ${configAsset}`);
        decorationAssetCache.set(skuId, configAsset);
        return configAsset;
    }

    // 2. Probe Discord's store published-listing for the SKU and log the full response
    //    so we can identify which field contains the decoration hash.
    try {
        const { data } = await api.get(`/store/published-listings/skus/${skuId}`);
        Logger.info(`Store listing for sku ${skuId}: ${JSON.stringify(data).slice(0, 800)}`);

        // Try common locations where a decoration hash might live in the store response
        const candidates: string[] = [
            data?.sku?.application?.cover_image,
            data?.listing?.sku?.application?.cover_image,
            data?.sku?.asset,
            data?.asset,
        ].filter((v): v is string => typeof v === 'string' && v.length > 0);

        if (candidates.length > 0) {
            Logger.info(`Decoration asset candidates from store for sku ${skuId}: ${JSON.stringify(candidates)}`);
        }
    } catch (err: any) {
        Logger.info(`Store listing probe failed for sku ${skuId}: ${err?.response?.status ?? err?.message}`);
    }

    // Could not determine the asset hash — cache null to avoid hammering the API
    decorationAssetCache.set(skuId, null);
    return null;
}

export class User extends EventEmitter {
    token: string;
    id: string;
    i18n: I18nInstance;
    destroyed: boolean = false;
    proxy: ProxyInterface | null;
    _api: AxiosInstance;
    selectedQuest: Quest | null = null;
    process: ChildProcess | null = null;
    started: boolean = false;
    logs: string[] = [];
    completed: boolean = false;
    stoped: boolean = false;
    quests: Collection<string, Quest> = new Collection();
    avatarFrameBuffer: Buffer | null = null;
    rawAvatarBuffer: Buffer | null = null;
    avatarDecorationRawBuffer: Buffer | null = null;
    questDecorationBuffer: Buffer | null = null;
    private _onExit: ((...args: any[]) => void) | null = null;
    private _onMessage: ((...args: any[]) => void) | null = null;

    constructor(token: string, proxy?: ProxyInterface) {
        if (!isValidDiscordToken(token) || !getIdFromToken(token)) throw new Error("Invalid Discord Token");
        super();
        this.token = token;
        this.proxy = proxy || null;
        this._api = null;

        this.id = getIdFromToken(this.token);
        usersCache.set(this.id, this);
        this.i18n = i18n.get(config.defaultLanguage);

        // Load avatar frame asynchronously without blocking constructor
        setImmediate(() => {
            this.refreshAvatarFrame().catch(err => {
                Logger.error(`Failed to load avatar frame for user ${this.id}:`, err);
            });
        });
    }

    setI18n(i18n: I18nInstance): void {
        this.i18n = i18n;
    }

    get api(): AxiosInstance {
        if (!this._api) {
            this._api = customAxiosWithProxy(this.token, this.proxy);
        }
        return this._api;
    }

    setQuest(quest: Quest): void {
        if (this.started) return;
        this.selectedQuest = quest;
    }

    setProcess(process: ChildProcess): void {
        this.process = process;

        this._onExit = () => this.destroy();
        this._onMessage = (message: ChildMessage) => this.emit("message", message);

        this.process.on("exit", this._onExit);
        this.process.on("message", this._onMessage);
    }

    clearProcessListeners(): void {
        if (!this.process) return;
        if (this._onExit) this.process.off("exit", this._onExit);
        if (this._onMessage) this.process.off("message", this._onMessage);
        this._onExit = null;
        this._onMessage = null;
    }

    send(message: ChildMessage): void {
        if (this.process && this.process.send) {
            this.process.send(message);
        }
    }

    async sendCompleted(): Promise<void> {
        const guild = client.guilds.cache.get(questsConfig.serverId) || await client.guilds.fetch(questsConfig.serverId).catch(() => null);
        if (!guild) return;

        const channel = guild.channels.cache.get(questsConfig.completedQuestsChannel) || await guild.channels.fetch(questsConfig.completedQuestsChannel).catch(() => null);
        if (!channel?.isTextBased()) return;

        const user: discordUser | null = client.users.cache.get(this.id) || await client.users.fetch(this.id).catch(() => null);

        if (this.selectedQuest) {
            await this.selectedQuest.incrementQuestSolved();
            const solveCount = await this.selectedQuest.getSolvedCount();

            const messageContent = this.generateMessage();
            const embed = messageContent?.embeds?.[0] as EmbedBuilder;

            const completedEmbed = new EmbedBuilder()
                .setTitle("Quest Completed")
                .setColor(embed.data.color || 0x00FF00)
                .setDescription(`- **Username:** \`${user ? user.tag : '-'}\`\n- **User ID:** \`${this.id}\`\n- **Quest:** \`${this.selectedQuest.id}\`\n- **Solve Count:** \`${solveCount.toLocaleString()}\``);

            await channel.send({ embeds: [completedEmbed, embed] });
        }
    }

    async start(): Promise<boolean> {
        if (!this.selectedQuest || !this.process) return false;
        if (this.started) return false;

        const quest = this.selectedQuest;
        const solveMethod = quest.solveMethod;
        const current = solveMethod.current;
        const target = solveMethod.target;

        this.started = true;
        this.quests.clear();
        this.quests.set(this.selectedQuest.id, this.selectedQuest);

        this.send({
            type: "start",
            data: {
                token: this.token,
                questId: this.selectedQuest.id,
                proxy: this.proxy,
                method: this.selectedQuest.solveMethod.id,
                current,
                target
            }
        });

        return true;
    }

    async stop(immediate: boolean = false): Promise<void> {
        if (this.stoped) return;
        this.stoped = true;

        if (this.process) {
            this.send({
                type: "kill",
                target: this.selectedQuest?.id
            });
        }

        this.emit("stopped", true);

        if (immediate) {
            this.destroy();
            return;
        }

        setTimeout(() => {
            this.destroy();
        }, 500);
    }

    async updateProgress(progress: number, completed: boolean): Promise<void> {
        if (this.completed) return;

        const quest = this.selectedQuest;
        if (!quest) return;

        const methodId = quest.solveMethod?.id;
        if (!methodId) return;

        let currentProgress = quest.data?.user_status?.progress?.[methodId];

        if (!currentProgress) {
            await this.fetchQuests();
            if (this.selectedQuest) {
                currentProgress = this.selectedQuest.data?.user_status?.progress?.[methodId];
            }
            if (!currentProgress) return;
        }

        currentProgress.value = progress;
        if (completed) {
            this.completed = true;
            currentProgress.completed_at = new Date().toISOString();
        }

        if (quest.data?.user_status?.progress) {
            quest.data.user_status.progress[methodId] = currentProgress;
        }
    }

    async fetchQuests(): Promise<Collection<string, Quest> | null> {
        try {
            const { data } = await this.api.get("/quests/@me");

            if (!Array.isArray(data?.quests)) {
                return null;
            }

            this.quests.clear();

            for (const questData of data.quests) {
                const quest = new Quest(questData, this);
                this.quests.set(quest.id, quest);
            }

            for (const [id, quest] of this.quests) {
                const expiresAt = quest.data?.config?.expires_at;
                if (expiresAt && !moment(expiresAt).isAfter(moment())) {
                    this.quests.delete(id);
                }
            }

            if (this.selectedQuest) {
                this.selectedQuest = this.quests.get(this.selectedQuest.id) || null;
            }

            if (this.started && this.selectedQuest) {
                this.quests.clear();
                this.quests.set(this.selectedQuest.id, this.selectedQuest);
            }

            return this.quests.size > 0 ? this.quests : null;
        } catch (err) {
            Logger.error("Error fetching quests:", err);
            return null;
        }
    }

    async refreshAvatarFrame(): Promise<void> {
        try {
            Logger.info(`Refreshing avatar frame for user ${this.id}`);

            const { data } = await this.api.get("/users/@me");

            const avatarHash: string | null = data.avatar ?? null;
            const avatarDecorationData = data.avatar_decoration_data;
            const hasDecoration = avatarDecorationData && 
                                 avatarDecorationData.asset && 
                                 typeof avatarDecorationData.asset === 'string';

            Logger.info(`User ${this.id} — avatar: ${avatarHash ?? "default"}, decoration_data: ${JSON.stringify(avatarDecorationData)}, hasDecoration: ${hasDecoration}`);

            // Get avatar URL
            let avatarUrl: string;
            if (avatarHash) {
                avatarUrl = `https://cdn.discordapp.com/avatars/${this.id}/${avatarHash}.png?size=256`;
            } else {
                const index = Number((BigInt(this.id) >> 22n) % 6n);
                avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
            }

            // Fetch avatar
            const avatarResp = await axios.get(avatarUrl, { 
                responseType: "arraybuffer",
                timeout: 10000 
            });

            // Process avatar
            const avatarBuffer = await sharp(Buffer.from(avatarResp.data))
                .resize(256, 256, {
                    fit: 'cover',
                    position: 'center'
                })
                .png()
                .toBuffer();

            // Store the raw avatar (no decoration) for quest decoration compositing
            this.rawAvatarBuffer = avatarBuffer;

            if (hasDecoration) {
                const decorationAsset = avatarDecorationData.asset;
                const decorationUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${decorationAsset}.png?size=256`;

                try {
                    Logger.debug(`Fetching decoration from: ${decorationUrl}`);

                    const decoResp = await axios.get(decorationUrl, {
                        responseType: "arraybuffer",
                        timeout: 10000
                    });

                    const decorationBuffer = await sharp(Buffer.from(decoResp.data))
                        .resize(256, 256, { fit: 'contain', position: 'center' })
                        .png()
                        .toBuffer();

                    // Store the raw decoration so it can be reused without re-fetching
                    this.avatarDecorationRawBuffer = decorationBuffer;

                    this.avatarFrameBuffer = await this.composeAvatarWithDecoration(avatarBuffer, decorationBuffer);

                    Logger.debug(`Successfully applied avatar decoration for user ${this.id}`);

                } catch (decoErr) {
                    Logger.error(`Failed to fetch decoration for user ${this.id}:`, decoErr);
                    this.avatarDecorationRawBuffer = null;
                    this.avatarFrameBuffer = avatarBuffer;
                }
            } else {
                this.avatarDecorationRawBuffer = null;
                this.avatarFrameBuffer = avatarBuffer;
                Logger.debug(`No decoration found for user ${this.id}`);
            }

        } catch (err) {
            Logger.error(`Failed to refresh avatar frame for user ${this.id}:`, err);
            this.avatarFrameBuffer = null;
        }
    }

    async updateAvatarDecoration(): Promise<boolean> {
        await this.refreshAvatarFrame();
        return this.avatarFrameBuffer !== null;
    }

    /**
     * Composites a circular avatar inside a decoration frame.
     * The avatar is scaled to ~78% of the frame to fit Discord's inner circle,
     * then the decoration is placed on top with its transparent center revealing the avatar.
     */
    private async composeAvatarWithDecoration(avatarBuffer: Buffer, decorationBuffer: Buffer): Promise<Buffer> {
        const frameSize = 256;
        const innerSize = Math.round(frameSize * 0.78); // ~200 px — matches Discord's inner circle

        // Create a circular SVG mask for the avatar
        const half = Math.round(innerSize / 2);
        const circleMask = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${innerSize}" height="${innerSize}">` +
            `<circle cx="${half}" cy="${half}" r="${half}" fill="white"/>` +
            `</svg>`
        );

        // Resize avatar and apply circular crop
        const circularAvatar = await sharp(avatarBuffer)
            .resize(innerSize, innerSize, { fit: 'cover', position: 'center' })
            .composite([{ input: circleMask, blend: 'dest-in' }])
            .png()
            .toBuffer();

        // Place circular avatar centered on a transparent canvas, then put decoration on top
        return sharp({
            create: { width: frameSize, height: frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
        })
            .png()
            .composite([
                { input: circularAvatar, blend: 'over', gravity: 'center' },
                { input: decorationBuffer, blend: 'over', gravity: 'center' }
            ])
            .png()
            .toBuffer();
    }

    async buildQuestDecorationThumbnail(quest: Quest): Promise<Buffer | null> {
        try {
            const baseAvatar = this.rawAvatarBuffer ?? this.avatarFrameBuffer;
            if (!baseAvatar) return null;

            // 1. Prefer decoration already fetched from the user's profile (has decoration equipped)
            if (this.avatarDecorationRawBuffer) {
                Logger.info(`User ${this.id}: using profile decoration for quest thumbnail`);
                return await this.composeAvatarWithDecoration(baseAvatar, this.avatarDecorationRawBuffer);
            }

            // 2. Fallback: look up the decoration preset hash via config or store API.
            const reward = quest.rewards?.[0];
            const skuId = reward?.sku_id;
            if (!skuId) return null;

            const decorationAsset = await lookupDecorationAsset(this.api, skuId);

            if (!decorationAsset) {
                Logger.info(`User ${this.id}: no decoration preset found for sku_id ${skuId}`);
                return null;
            }

            // passthrough=false tells Discord CDN to return a static PNG even for animated decorations
            const decorationUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${decorationAsset}.png?size=256&passthrough=false`;
            Logger.info(`User ${this.id}: fetching decoration overlay from ${decorationUrl}`);

            const resp = await axios.get(decorationUrl, { responseType: "arraybuffer", timeout: 10000 });
            const decoBuffer = await sharp(Buffer.from(resp.data))
                .resize(256, 256, { fit: 'contain', position: 'center' })
                .png()
                .toBuffer();

            // Cache it so refreshQuestDecoration() re-uses without another fetch
            this.avatarDecorationRawBuffer = decoBuffer;
            Logger.info(`User ${this.id}: decoration overlay fetched and composited successfully`);
            return await this.composeAvatarWithDecoration(baseAvatar, decoBuffer);
        } catch (err) {
            Logger.error(`Failed to build quest decoration thumbnail for user ${this.id}:`, err);
            return null;
        }
    }

    async refreshQuestDecoration(): Promise<void> {
        const quest = this.selectedQuest;
        if (!quest) { this.questDecorationBuffer = null; return; }
        const reward = quest.rewards?.[0];
        if (reward?.type === RewardType.DiscordDecorations) {
            this.questDecorationBuffer = await this.buildQuestDecorationThumbnail(quest);
        } else {
            this.questDecorationBuffer = null;
        }
    }

    consoleString(): string {
        let lines: string[] = Array.from(new Set(this.logs.filter(d => d && d.trim().length > 0)));
        lines = lines.map((line: string, i) => `[${i + 1}] ${line}`.trim());

        const maxLines: number = 15;
        if (lines.length > maxLines) {
            lines = lines.slice(lines.length - maxLines);
        }
        let output: string = (questsConfig.logStrings || []).join("\n");
        lines.forEach(line => output += `${line}\n`);
        return output;
    }

    private buildProgressBar(percent: number, steps: number = 12): string {
        const filled = Math.round((percent / 100) * steps);
        const empty = steps - filled;
        return `${"█".repeat(filled)}${"░".repeat(empty)}`;
    }

    private getTaskName(taskId: string): string {
        if (!taskId) return "Unknown Task";

        const i18nKey = `events.${taskId}`;
        const translated = this.i18n.t(i18nKey);

        if (translated === i18nKey) {
            return taskId
                .split("_")
                .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(" ");
        }
        return translated;
    }

    generateMessage(): any {
        const i18n = this.i18n;
        const quest = this.selectedQuest;
        const files: AttachmentBuilder[] = [];
        const emojiList = client.emojisList || {};

        if (!quest) {
            return {
                files: [],
                embeds: [new EmbedBuilder()
                    .setDescription("No quest selected")
                    .setColor(0xFF0000)
                ],
                components: []
            };
        }

        const button = quest.button;
        const enrolled = quest.data?.user_status?.enrolled_at;
        const expiresAt = quest.data?.config?.expires_at;
        const image = quest.image;

        // Rewards section
        const rewardLines = (quest.rewards || []).map(reward => {
            let text = reward.messages?.name || "Unknown Reward";
            const emoji = emojiList[`${reward.type}`];

            if ([1, 3].includes(reward.expiration_mode) && reward.expires_at && quest.startsAt) {
                const dur = moment(reward.expires_at).diff(moment(quest.startsAt), "months");
                text += ` ${i18n.t("for")} ${dur} ${i18n.t("months")}`;
            }

            if (emoji) text += ` ${emoji}`;
            return `> ✦ **${text}**`;
        });

        // Tasks section
        const taskLines = (quest.progress || []).map(task => {
            const isDuration = task.type === "duration";
            const rawTarget = isDuration ? task.target * 1000 : task.target;
            const rawCurrent = isDuration ? task.current * 1000 : task.current;

            const fmtTarget = isDuration
                ? client.formatDuration?.(rawTarget, i18n.getLang(), ["m", "s"]) || String(task.target)
                : String(task.target);

            const fmtCurrent = isDuration
                ? client.formatDuration?.(rawCurrent, i18n.getLang(), ["m", "s"]) || String(task.current)
                : String(task.current);

            const bar = this.buildProgressBar(task.percent);
            const taskName = this.getTaskName(task.id);
            const emoji = task.emoji ? `${task.emoji} ` : "";
            const statusStr = task.completed
                ? `✅ ${i18n.t("buttons.completed")}`
                : `\`${fmtCurrent}\` **/** \`${fmtTarget}\``;

            return `-# ${emoji}**${taskName}** · \`${bar}\` ${task.percent}% · ${statusStr}`;
        });

        const statusIcon = this.completed ? "✅" : this.stoped ? "⏹️" : this.started ? "🟢" : "⏸️";

        let description = `### 🎁 ${i18n.t("message.rewards")}\n${rewardLines.join("\n")}`;
        description += `\n\n### 📋 ${i18n.t("message.tasks")}\n${taskLines.join("\n")}`;

        const embed = new EmbedBuilder()
            .setTitle(`${statusIcon} ${quest.data?.config?.messages?.quest_name || "Unknown Quest"}`)
            .setAuthor({
                name: `${quest.data?.config?.messages?.game_title || "Unknown Game"} · ${quest.data?.config?.messages?.game_publisher || "Unknown Publisher"}`,
                iconURL: image ?? undefined,
            })
            .addFields(
                {
                    name: `📅 ${i18n.t("message.enrolledAt")}`,
                    value: enrolled
                        ? formatDiscordTimestamp(new Date(enrolled).getTime(), "Date")
                        : "`—`",
                    inline: true,
                },
                {
                    name: `⏳ ${i18n.t("message.expiresAt")}`,
                    value: expiresAt
                        ? formatDiscordTimestamp(new Date(expiresAt).getTime(), "Date")
                        : "`—`",
                    inline: true,
                }
            )
            .setColor(quest.data?.config?.colors?.primary ? `#${quest.data.config.colors.primary.replace("#", "")}` : 0x5865F2)
            .setImage(quest.assets?.hero || null)
            .setTimestamp(quest.startsAt ? moment(quest.startsAt).toDate() : new Date())
            .setFooter({ text: quest.data?.config?.application?.name || "Discord Quests" })
            .setDescription(description);

        // Add thumbnail: for avatar decoration rewards use the quest decoration composited onto the user's avatar
        const isDecorationReward = quest.rewards?.[0]?.type === RewardType.DiscordDecorations;
        if (isDecorationReward && this.questDecorationBuffer) {
            files.push(new AttachmentBuilder(this.questDecorationBuffer, { name: "avatar_frame.png" }));
            embed.setThumbnail("attachment://avatar_frame.png");
        } else if (this.avatarFrameBuffer) {
            files.push(new AttachmentBuilder(this.avatarFrameBuffer, { name: "avatar_frame.png" }));
            embed.setThumbnail("attachment://avatar_frame.png");
        } else if (image) {
            embed.setThumbnail(image);
        }

        // Create selection menu
        const menu = new StringSelectMenuBuilder()
            .setCustomId("selectBadge")
            .setPlaceholder(`🎯 ${i18n.t("badge.selectPlaceholder")}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setDisabled(this.started || this.stoped);

        this.quests.forEach((q) => {
            if (!q) return;

            const isCompleted = q.isCompleted();
            const isSupported = q.isSupported();
            const statusEmoji = isCompleted
                ? (client.getEmoji?.("completed", false) || "✅")
                : !isSupported
                    ? (client.getEmoji?.("notsupported", false) || "🔴")
                    : q.emoji;

            menu.addOptions({
                label: (q.displayLabel || "Unknown Quest").trim().slice(0, 100),
                value: q.id,
                default: q.id === this.selectedQuest?.id,
                description: (q.rewardLabel || "No reward").trim().slice(0, 100),
                emoji: statusEmoji || undefined,
            });
        });

        const embeds = [embed];

        if (this.started) {
            const logEmbed = new EmbedBuilder()
                .setTitle(`📄 ${i18n.t("badge.logs")}`)
                .setDescription(`\`\`\`prolog\n${this.consoleString().trim() || "No logs available"}\n\`\`\``)
                .setColor(embed.data.color || 0x5865F2);
            embeds.push(logEmbed);
        }

        if (this.started && this.completed) {
            const passEmbed = new EmbedBuilder()
                .setColor(embed.data.color || 0x5865F2)
                .setDescription(`> ⚠️ ${i18n.t("badge.pleaseChangeYourPassword")}`);
            embeds.push(passEmbed);
        }

        // Create buttons
        const refreshButton = new ButtonBuilder()
            .setCustomId("refresh")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(this.started || this.stoped);

        const hasRunnable = Array.from(this.quests.values()).some(q => q && !q.isCompleted() && q.isSupported());
        const runAllButton = new ButtonBuilder()
            .setCustomId("run_all")
            .setEmoji("🚀")
            .setLabel(i18n.t("buttons.runAll"))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(this.started || this.stoped || !hasRunnable);

        const questLink = new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setEmoji("🔗")
            .setLabel(i18n.t("badge.ViewQuest"))
            .setURL(`https://discord.com/quests/${this.selectedQuest.id}`);

        const buttonsRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(button || refreshButton)
            .addComponents(refreshButton)
            .addComponents(runAllButton)
            .addComponents(questLink);

        // Add custom buttons from config
        const customButtons = questsConfig.buttons || [];
        for (const btn of customButtons) {
            if (btn && btn.url) {
                // حل المشكلة: التحقق من نوع الـ emoji
                let emojiValue: string | undefined;

                if (btn.emoji) {
                    if (typeof btn.emoji === 'function') {
                        // إذا كانت دالة، نستدعيها ونحول الناتج إلى string
                        const emojiResult = btn.emoji(client as CustomClient);
                        emojiValue = String(emojiResult);
                    } else {
                        // إذا كانت string، نستخدمها مباشرة
                        emojiValue = String(btn.emoji);
                    }
                }

                // استخدام btn.label بدلاً من btn.text
                const buttonBuilder = new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel(btn.label || "Link") // استخدام label بدلاً من text
                    .setURL(btn.url || "https://discord.com");

                if (emojiValue) {
                    buttonBuilder.setEmoji(emojiValue);
                }

                buttonsRow.addComponents(buttonBuilder);
            }
        }

        return {
            files,
            embeds,
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
                buttonsRow
            ],
        };
    }

    prepareForNextQuest(nextQuest: Quest, remainingQuests: Collection<string, Quest>): void {
        this.clearProcessListeners();
        this.started = false;
        this.stoped = false;
        this.completed = false;
        this.logs = this.logs.slice(-3);
        this.quests = remainingQuests;
        this.selectedQuest = nextQuest;
    }

    destroy(): void {
        this.destroyed = true;
        usersCache.delete(this.id);

        this.quests.forEach(quest => quest.destroy());
        this.quests.clear();

        if (this.selectedQuest) {
            this.quests.set(this.selectedQuest.id, this.selectedQuest);
        }

        this.process = null;
        this.proxy = null;
        this.logs = this.logs.reverse().slice(0, 5).reverse();
        this.removeAllListeners();
        this.clearProcessListeners();
        this.avatarFrameBuffer = null;
    }
}
