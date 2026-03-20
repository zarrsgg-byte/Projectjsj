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

// Cache for decoration assets
const decorationAssetCache = new Map<string, string | null>();

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
    avatarFrameBuffer: Buffer | null = null;
    rawAvatarBuffer: Buffer | null = null;
    avatarDecorationRawBuffer: Buffer | null = null;
    questDecorationBuffer: Buffer | null = null;
    questRewardImageBuffer: Buffer | null = null;
    showQuestImageInsteadOfAvatar: boolean = true;
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

        setImmediate(() => {
            this.loadUserAvatar().catch(err => {
                Logger.error(`Failed to load avatar for user ${this.id}:`, err);
            });
            this.loadUserProfile().catch(err => {
                Logger.error(`Failed to load user profile:`, err);
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

    async loadUserAvatar(): Promise<Buffer | null> {
        try {
            Logger.info(`Loading avatar for user ${this.id}`);

            const { data } = await this.api.get("/users/@me");
            const avatarHash: string | null = data.avatar ?? null;

            let avatarUrl: string;
            if (avatarHash) {
                avatarUrl = `https://cdn.discordapp.com/avatars/${this.id}/${avatarHash}.png?size=512`;
            } else {
                const index = Number((BigInt(this.id) >> 22n) % 6n);
                avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
            }

            const avatarResp = await axios.get(avatarUrl, { 
                responseType: "arraybuffer",
                timeout: 10000 
            });

            const avatarBuffer = await sharp(Buffer.from(avatarResp.data))
                .resize(512, 512, {
                    fit: 'cover',
                    position: 'center'
                })
                .png()
                .toBuffer();

            this.rawAvatarBuffer = avatarBuffer;
            Logger.info(`Successfully loaded avatar (${avatarBuffer.length} bytes)`);

            return avatarBuffer;
        } catch (err) {
            Logger.error(`Failed to load avatar:`, err);
            return null;
        }
    }

    async loadUserProfile(): Promise<void> {
        try {
            Logger.info(`Loading user profile for ${this.id}`);

            const { data } = await this.api.get("/users/@me");

            const avatarDecorationData = data.avatar_decoration_data;
            const hasDecoration = avatarDecorationData && 
                                 avatarDecorationData.asset && 
                                 typeof avatarDecorationData.asset === 'string';

            if (hasDecoration) {
                const decorationAsset = avatarDecorationData.asset;
                Logger.info(`Found decoration asset in profile: ${decorationAsset}`);

                const decorationUrl = `https://cdn.discordapp.com/avatar-decoration-presets/${decorationAsset}.png?size=512&passthrough=false`;

                const decoResp = await axios.get(decorationUrl, {
                    responseType: "arraybuffer",
                    timeout: 10000
                });

                const decorationBuffer = await sharp(Buffer.from(decoResp.data))
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .png()
                    .toBuffer();

                this.avatarDecorationRawBuffer = decorationBuffer;
                Logger.info(`Successfully loaded decoration (${decorationBuffer.length} bytes)`);

                if (!this.rawAvatarBuffer) {
                    Logger.info(`User ${this.id}: rawAvatarBuffer not ready, loading avatar before compositing`);
                    await this.loadUserAvatar();
                }

                if (this.rawAvatarBuffer) {
                    this.avatarFrameBuffer = await this.createFinalAvatarImageSimple(this.rawAvatarBuffer, decorationBuffer);
                    Logger.info(`User ${this.id}: Avatar frame created successfully with profile decoration`);
                } else {
                    Logger.error(`User ${this.id}: Avatar buffer still null after loading, cannot create frame`);
                }
            } else {
                Logger.info(`No decoration found in profile`);
                if (!this.rawAvatarBuffer) {
                    await this.loadUserAvatar();
                }
                if (this.rawAvatarBuffer) {
                    this.avatarFrameBuffer = await this.createCircularAvatar(this.rawAvatarBuffer);
                    Logger.info(`User ${this.id}: Circular avatar created (no decoration)`);
                }
            }
        } catch (err) {
            Logger.error(`Failed to load user profile:`, err);
        }
    }

    async refreshAvatarFrame(): Promise<void> {
        try {
            if (!this.rawAvatarBuffer) {
                await this.loadUserAvatar();
            }

            if (this.avatarDecorationRawBuffer && this.rawAvatarBuffer) {
                this.avatarFrameBuffer = await this.createFinalAvatarImageSimple(this.rawAvatarBuffer, this.avatarDecorationRawBuffer);
            } else if (this.rawAvatarBuffer) {
                this.avatarFrameBuffer = await this.createCircularAvatar(this.rawAvatarBuffer);
                Logger.info(`User ${this.id}: Circular avatar created in refreshAvatarFrame (no decoration)`);
            }
        } catch (err) {
            Logger.error(`Failed to refresh avatar frame:`, err);
            this.avatarFrameBuffer = this.rawAvatarBuffer || null;
        }
    }

    async updateAvatarDecoration(): Promise<boolean> {
        await this.loadUserProfile();
        return this.avatarFrameBuffer !== null;
    }

    toggleShowQuestImage(show: boolean): void {
        this.showQuestImageInsteadOfAvatar = show;
        Logger.info(`User ${this.id}: Show quest image instead of avatar set to ${show}`);
    }

    async logRewardInfo(): Promise<void> {
        const quest = this.selectedQuest;
        if (!quest) {
            Logger.info(`User ${this.id}: No quest selected`);
            return;
        }

        const rewards = quest.rewards || [];
        Logger.info(`User ${this.id}: Quest ${quest.id} has ${rewards.length} rewards:`);
        
        for (let i = 0; i < rewards.length; i++) {
            const reward = rewards[i];
            Logger.info(`User ${this.id}: Reward ${i + 1} - Type: ${reward.type}, Asset: ${reward.asset?.substring(0, 50) || 'NO ASSET'}, Name: ${reward.messages?.name}`);
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

    /**
     * Apply smart masking to decoration - removes very dark backgrounds while preserving decoration
     * Uses brightness thresholding to remove dark pixels and enhance remaining ones
     */
    private async applySmartMask(decorationBuffer: Buffer, size: number): Promise<Buffer> {
        try {
            Logger.info(`Applying smart mask to decoration (size: ${size}x${size})`);
            
            const { data, info } = await sharp(decorationBuffer)
                .resize(size, size, { fit: "contain" })
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });

            const output = Buffer.from(data);
            let darkPixelsRemoved = 0;
            let totalPixels = info.width * info.height;

            for (let i = 0; i < totalPixels; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];

                // Calculate brightness
                const brightness = (r + g + b) / 3;

                // Remove only dark background pixels
                if (brightness < 40) {
                    output[i * 4 + 3] = 0; // Transparent
                    darkPixelsRemoved++;
                } else {
                    // Enhance brightness for decoration pixels
                    output[i * 4 + 3] = Math.min(255, brightness * 1.2);
                }
            }

            Logger.info(`Smart mask applied: removed ${darkPixelsRemoved}/${totalPixels} dark pixels (${((darkPixelsRemoved / totalPixels) * 100).toFixed(1)}%)`);

            return sharp(output, {
                raw: {
                    width: info.width,
                    height: info.height,
                    channels: 4
                }
            }).png().toBuffer();
            
        } catch (err) {
            Logger.error("applySmartMask failed:", err);
            return decorationBuffer; // Return original on error
        }
    }

    /**
     * Convert avatar to circular shape
     */
    private async createCircularAvatar(avatarBuffer: Buffer): Promise<Buffer> {
        const size = 512;
        try {
            const circleSvg = Buffer.from(`
                <svg width="${size}" height="${size}">
                    <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/>
                </svg>
            `);

            return await sharp(avatarBuffer)
                .resize(size, size, { fit: "cover", position: "attention" })
                .composite([{ input: circleSvg, blend: "dest-in" }])
                .png()
                .toBuffer();
        } catch (err) {
            Logger.error("createCircularAvatar failed:", err);
            return avatarBuffer;
        }
    }

    /**
     * Create final avatar image with smart masking
     * 1. Crop avatar to circle
     * 2. Apply smart mask to decoration (removes dark backgrounds)
     * 3. Composite avatar (background) + masked decoration (foreground)
     */
    private async createFinalAvatarImageSimple(
        avatarBuffer: Buffer,
        decorationBuffer: Buffer
    ): Promise<Buffer> {
        const size = 512;

        try {
            Logger.info(`Creating final avatar image with smart mask decoration`);
            
            // 1️⃣ Create circular avatar
            const circleSvg = Buffer.from(`
                <svg width="${size}" height="${size}">
                    <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/>
                </svg>
            `);

            const circularAvatar = await sharp(avatarBuffer)
                .resize(size, size, {
                    fit: "cover",
                    position: "attention"
                })
                .composite([{ input: circleSvg, blend: "dest-in" }])
                .png()
                .toBuffer();

            // 2️⃣ Apply smart mask to decoration
            const maskedDecoration = await this.applySmartMask(decorationBuffer, size);
            
            // 3️⃣ Ensure decoration is properly sized
            const decoration = await sharp(maskedDecoration)
                .resize(size, size, {
                    fit: "contain",
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .png()
                .toBuffer();

            // 4️⃣ Composite: avatar background + decoration foreground
            const result = await sharp({
                create: {
                    width: size,
                    height: size,
                    channels: 4,
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                }
            })
            .composite([
                { input: circularAvatar, blend: "over" },     // Avatar in background
                { input: decoration, blend: "over" }          // Masked decoration in foreground
            ])
            .png()
            .toBuffer();

            Logger.info(`Smart mask avatar decoration created successfully`);
            return result;

        } catch (err) {
            Logger.error("Smart mask avatar decoration failed:", err);
            // Fallback to circular avatar only
            return this.rawAvatarBuffer 
                ? await this.createCircularAvatar(this.rawAvatarBuffer)
                : avatarBuffer;
        }
    }

    async buildQuestDecorationThumbnail(quest: Quest): Promise<Buffer | null> {
        try {
            Logger.info(`User ${this.id}: Starting to build quest decoration thumbnail`);
            
            if (!this.rawAvatarBuffer) {
                Logger.info(`User ${this.id}: Loading user avatar...`);
                await this.loadUserAvatar();
            }

            if (!this.rawAvatarBuffer) {
                Logger.error(`User ${this.id}: Failed to load avatar buffer`);
                return null;
            }

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

            Logger.info(`User ${this.id}: Reward type ${reward.type} is an avatar decoration reward`);

            const asset = reward.asset;
            let decorationBuffer: Buffer | null = null;

            // First attempt: load decoration from quest asset
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
                        Logger.info(`User ${this.id}: asset is video and no cached PNG yet, will show circular avatar`);
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

            // Second attempt: use user's active profile decoration as fallback
            if (!decorationBuffer && this.avatarDecorationRawBuffer) {
                Logger.info(`User ${this.id}: using user's profile decoration as fallback`);
                decorationBuffer = this.avatarDecorationRawBuffer;
            }

            // No decoration available - show circular avatar only
            if (!decorationBuffer) {
                Logger.info(`User ${this.id}: no decoration available, returning circular avatar`);
                return this.rawAvatarBuffer
                    ? await this.createCircularAvatar(this.rawAvatarBuffer)
                    : null;
            }

            Logger.info(`User ${this.id}: Decoration processed successfully, creating final avatar image with smart mask`);

            // Use smart mask method to combine avatar with decoration
            const result = await this.createFinalAvatarImageSimple(
                this.rawAvatarBuffer,
                decorationBuffer
            );

            if (result) {
                Logger.info(`User ${this.id}: Quest decoration thumbnail built successfully with avatar inside`);
                return result;
            } else {
                Logger.warn(`User ${this.id}: Failed to create avatar with decoration`);
                return null;
            }

        } catch (err) {
            Logger.error(`User ${this.id}: Failed to build quest decoration:`, err);
            return null;
        }
    }

    async refreshQuestDecoration(): Promise<void> {
        const quest = this.selectedQuest;
        if (!quest) { 
            this.questDecorationBuffer = null; 
            this.questRewardImageBuffer = null; 
            return; 
        }

        const reward = quest.rewards?.[0];
        // Only type 3 is avatar decoration - type 4 (DiscordOrb) is not an avatar decoration
        const isAvatarDecorationReward = reward?.type === RewardType.DiscordDecorations;

        if (isAvatarDecorationReward) {
            Logger.info(`User ${this.id}: refreshing decoration for avatar decoration quest (type: ${reward?.type})`);
            this.questDecorationBuffer = await this.buildQuestDecorationThumbnail(quest);
            // Always show avatar for decoration quests (with or without decoration)
            this.showQuestImageInsteadOfAvatar = false;
            Logger.info(`User ${this.id}: showQuestImageInsteadOfAvatar=false, questDecorationBuffer=${!!this.questDecorationBuffer}`);
        } else {
            Logger.info(`User ${this.id}: quest reward type ${reward?.type} is not avatar decoration — showing quest image`);
            this.questDecorationBuffer = null;
            this.questRewardImageBuffer = null;
            this.showQuestImageInsteadOfAvatar = true;
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

        // Display appropriate image
        if (this.showQuestImageInsteadOfAvatar && image) {
            embed.setThumbnail(image);
            Logger.info(`User ${this.id}: showing quest image as thumbnail: ${image}`);
        } 
        else if (isAvatarDecorationReward && this.questDecorationBuffer) {
            files.push(new AttachmentBuilder(this.questDecorationBuffer, { name: "avatar_with_decoration.png" }));
            embed.setThumbnail("attachment://avatar_with_decoration.png");
            Logger.info(`User ${this.id}: showing avatar with decoration`);
        } 
        else if (isAvatarDecorationReward && this.questRewardImageBuffer) {
            files.push(new AttachmentBuilder(this.questRewardImageBuffer, { name: "quest_reward.png" }));
            embed.setThumbnail("attachment://quest_reward.png");
            Logger.info(`User ${this.id}: showing quest reward image as fallback`);
        } 
        else if (this.avatarFrameBuffer) {
            files.push(new AttachmentBuilder(this.avatarFrameBuffer, { name: "avatar_frame.png" }));
            embed.setThumbnail("attachment://avatar_frame.png");
            Logger.info(`User ${this.id}: showing avatar frame`);
        } 
        else if (image) {
            embed.setThumbnail(image);
            Logger.info(`User ${this.id}: showing quest image`);
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
        this.avatarFrameBuffer = null;
        this.rawAvatarBuffer = null;
        this.avatarDecorationRawBuffer = null;
        this.questDecorationBuffer = null;
        this.questRewardImageBuffer = null;
        this.showQuestImageInsteadOfAvatar = true;
    }
}
