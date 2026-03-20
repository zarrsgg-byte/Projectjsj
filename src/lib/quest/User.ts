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

// دوال للتحقق من نوع الملف
function isVideoFile(url: string): boolean {
    const videoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.flv', '.wmv'];
    const lowerUrl = url.toLowerCase();
    return videoExtensions.some(ext => lowerUrl.endsWith(ext));
}

function isGifFile(url: string): boolean {
    return url.toLowerCase().endsWith('.gif');
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
    questDecorationBuffer: Buffer | null = null;
    questImageBuffer: Buffer | null = null;
    showQuestImage: boolean = true;
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

    private async convertGifToPng(gifBuffer: Buffer): Promise<Buffer> {
        try {
            Logger.info(`Converting GIF to static PNG...`);
            
            const pngBuffer = await sharp(gifBuffer, {
                animated: false,
                pages: 1
            })
            .png()
            .toBuffer();
            
            Logger.info(`Successfully converted GIF to PNG (${gifBuffer.length} -> ${pngBuffer.length} bytes)`);
            return pngBuffer;
        } catch (err) {
            Logger.error("Failed to convert GIF to PNG:", err);
            throw err;
        }
    }

    async loadQuestImage(quest: Quest): Promise<Buffer | null> {
        try {
            const imageUrl = quest.image;
            if (!imageUrl) {
                Logger.info(`User ${this.id}: No quest image URL found`);
                return null;
            }

            Logger.info(`User ${this.id}: Loading quest image from ${imageUrl}`);

            const isGif = isGifFile(imageUrl);
            const isVideo = isVideoFile(imageUrl);

            if (isVideo) {
                Logger.info(`User ${this.id}: Quest image is video, skipping`);
                return null;
            }

            const resp = await axios.get(imageUrl, { 
                responseType: "arraybuffer",
                timeout: 10000 
            });
            
            let imageBuffer = Buffer.from(resp.data);
            
            if (isGif) {
                imageBuffer = await this.convertGifToPng(imageBuffer);
            }
            
            const processedImage = await sharp(imageBuffer)
                .resize(512, 512, { 
                    fit: "contain", 
                    background: { r: 0, g: 0, b: 0, alpha: 0 } 
                })
                .png()
                .toBuffer();
            
            Logger.info(`User ${this.id}: Quest image loaded successfully (${processedImage.length} bytes)`);
            return processedImage;
            
        } catch (err) {
            Logger.error(`User ${this.id}: Failed to load quest image:`, err);
            return null;
        }
    }

    async loadQuestDecoration(quest: Quest): Promise<Buffer | null> {
        try {
            Logger.info(`User ${this.id}: Loading quest decoration for quest ${quest.id}`);
            
            const reward = quest.rewards?.[0];

            if (!reward) {
                Logger.warn(`User ${this.id}: No reward found in quest`);
                return null;
            }

            // Only type 3 (DiscordDecorations) is a real avatar decoration
            if (reward.type !== RewardType.DiscordDecorations) {
                Logger.info(`User ${this.id}: reward type ${reward.type} is not an avatar decoration, skipping`);
                return null;
            }

            Logger.info(`User ${this.id}: Loading avatar decoration reward`);

            const asset = reward.asset;
            let decorationBuffer: Buffer | null = null;

            // Load decoration from quest asset
            if (asset) {
                const decorationUrl = asset.startsWith("http")
                    ? asset
                    : quest.cdn(asset);

                Logger.info(`User ${this.id}: Decoration URL: ${decorationUrl}`);

                const isGif = isGifFile(decorationUrl);
                const isVideo = isVideoFile(decorationUrl);

                if (isVideo) {
                    // Asset is video - try cached PNG from quest.image
                    const questImage = quest.image;
                    if (questImage && !isVideoFile(questImage)) {
                        Logger.info(`User ${this.id}: asset is video, trying cached PNG from quest.image: ${questImage}`);
                        try {
                            const resp = await axios.get(questImage, { responseType: "arraybuffer", timeout: 10000 });
                            const imgBuf = isGifFile(questImage)
                                ? await this.convertGifToPng(Buffer.from(resp.data))
                                : Buffer.from(resp.data);
                            decorationBuffer = await sharp(imgBuf)
                                .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                                .png().toBuffer();
                            Logger.info(`User ${this.id}: cached PNG decoration loaded successfully`);
                        } catch (e) {
                            Logger.warn(`User ${this.id}: failed to load cached PNG: ${e}`);
                        }
                    } else {
                        Logger.info(`User ${this.id}: asset is video and no cached PNG yet`);
                        return null;
                    }
                } else {
                    if (isGif) {
                        Logger.info(`User ${this.id}: reward asset is a GIF, converting to PNG: ${decorationUrl}`);
                    } else {
                        Logger.info(`User ${this.id}: using quest decoration PNG: ${decorationUrl}`);
                    }

                    const resp = await axios.get(decorationUrl, { responseType: "arraybuffer", timeout: 10000 });
                    let imageBuffer = Buffer.from(resp.data);
                    if (isGif) imageBuffer = await this.convertGifToPng(imageBuffer);
                    decorationBuffer = await sharp(imageBuffer)
                        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        .png().toBuffer();
                }
            }

            if (!decorationBuffer) {
                Logger.info(`User ${this.id}: No decoration loaded`);
                return null;
            }

            Logger.info(`User ${this.id}: Decoration loaded successfully`);
            return decorationBuffer;

        } catch (err) {
            Logger.error(`User ${this.id}: Failed to load quest decoration:`, err);
            return null;
        }
    }

    async refreshQuestAssets(): Promise<void> {
        const quest = this.selectedQuest;
        if (!quest) { 
            this.questDecorationBuffer = null;
            this.questImageBuffer = null;
            return; 
        }

        // Load quest image
        this.questImageBuffer = await this.loadQuestImage(quest);
        
        // Load decoration if it's an avatar decoration quest
        const reward = quest.rewards?.[0];
        const isAvatarDecorationReward = reward?.type === RewardType.DiscordDecorations;

        if (isAvatarDecorationReward) {
            Logger.info(`User ${this.id}: Loading decoration for avatar decoration quest (type: ${reward?.type})`);
            this.questDecorationBuffer = await this.loadQuestDecoration(quest);
            // For decoration quests, show decoration instead of quest image
            this.showQuestImage = false;
            Logger.info(`User ${this.id}: showQuestImage=false, decoration loaded: ${!!this.questDecorationBuffer}`);
        } else {
            Logger.info(`User ${this.id}: quest reward type ${reward?.type} is not avatar decoration — showing quest image`);
            this.questDecorationBuffer = null;
            this.showQuestImage = true;
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

        // Only type 3 is a real avatar decoration
        const isAvatarDecorationReward = quest.rewards?.[0]?.type === RewardType.DiscordDecorations;

        // Display appropriate thumbnail based on quest type
        if (isAvatarDecorationReward && this.questDecorationBuffer) {
            // For decoration quests: show the decoration
            files.push(new AttachmentBuilder(this.questDecorationBuffer, { name: "avatar_decoration.png" }));
            embed.setThumbnail("attachment://avatar_decoration.png");
            Logger.info(`User ${this.id}: showing avatar decoration`);
        }
        else if (this.showQuestImage && this.questImageBuffer) {
            // For regular quests: show the quest image
            files.push(new AttachmentBuilder(this.questImageBuffer, { name: "quest_image.png" }));
            embed.setThumbnail("attachment://quest_image.png");
            Logger.info(`User ${this.id}: showing quest image`);
        }
        else if (image) {
            // Fallback to original image URL if buffers aren't available
            embed.setThumbnail(image);
            Logger.info(`User ${this.id}: showing quest image URL as fallback: ${image}`);
        }

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

        const customButtons = questsConfig.buttons || [];
        for (const btn of customButtons) {
            if (btn && btn.url) {
                let emojiValue: string | undefined;

                if (btn.emoji) {
                    if (typeof btn.emoji === 'function') {
                        const emojiResult = btn.emoji(client as CustomClient);
                        emojiValue = String(emojiResult);
                    } else {
                        emojiValue = String(btn.emoji);
                    }
                }

                const buttonBuilder = new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel(btn.label || "Link")
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
        this.questDecorationBuffer = null;
        this.questImageBuffer = null;
        this.showQuestImage = true;
    }
}
