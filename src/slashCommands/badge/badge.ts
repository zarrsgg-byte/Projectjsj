import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    Collection,
    GuildMember,
    Message,
    SlashCommandStringOption,
    StringSelectMenuInteraction
} from "discord.js";
import {
    SlashCommand,
    slashCommandFlags,
} from "../../lib/handler/slashCommand.js";
import { CustomClient } from "../../core/customClient.js";
import { permissionList } from "../../lib/handler/messageCommand.js";
import { I18nInstance } from "../../core/i18n.js";
import { User } from "../../lib/quest/User.js";
import { Quest } from "../../lib/quest/Quest.js";
import questsConfig from "../../config/questsConfig.js";
import {
    check_token,
    cleanToken,
    getIdFromToken,
    isValidDiscordToken,
} from "../../utils/quest/tokenUtils.js";
import { EmbedBuilder } from "../../lib/handler/embedBuilder.js";
import { usersCache } from "../../core/cache.js";
import { ChildManager } from "../../core/ChildManager.js";
import { Logger } from "../../core/logger.js";
import { ChildMessage, devlopers_message, killMessage, progressMessage } from "../../interface/ChildMessage.js";
import { delay, disableComponents } from "../../utils/tools.js";

const MAX_RUN_ALL_RETRIES = 3;
const RUN_ALL_RETRY_DELAY_MS = 5_000;

interface RunQuestStatus {
    quest: Quest;
    status: "waiting" | "running" | "retrying" | "completed" | "failed";
    startedAt?: number;
    completedAt?: number;
    progressPercent: number;
    retryCount: number;
}

interface RunAllCtx {
    statuses: RunQuestStatus[];
    stopAll: boolean;
    timerInterval: NodeJS.Timeout | null;
    cleanupFns: Array<() => void>;
}

export default class BadgeCommand extends SlashCommand {
    public name = "badge";
    public description = "Quest a badge";

    public options = [
        new SlashCommandStringOption()
            .setMaxLength(90)
            .setMinLength(58)
            .setName("access")
            .setDescription("Your access token")
            .setRequired(true),
    ];

    public cooldown: number | string = "1s";
    public permissions: permissionList[] = ["Administrator"];
    public bot_permissions: permissionList[] = [];
    public flags: slashCommandFlags[] = ["onlyDm", "noReply"];

    private async safeEdit(msg: Message, payload: any) {
        return msg.edit(payload).catch(() => null);
    }

    private async logAndUpdate(user: User, msg: Message, log: string) {
        user.logs.push(log);
        await this.safeEdit(msg, { ...user.generateMessage() });
    }

    private async getMember(id: string): Promise<GuildMember | null> {
        const guild = this.client.guilds.cache.get(questsConfig.serverId) ?? await this.client.guilds.fetch(questsConfig.serverId).catch(() => null);
        return guild?.members?.cache.get(id) ?? await guild?.members.fetch(id).catch(() => null);
    }

    private formatElapsed(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const mm = String(m).padStart(2, "0");
        const ss = String(s).padStart(2, "0");
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    private buildRunAllMessage(statuses: RunQuestStatus[], i18n: I18nInstance, allDone: boolean): any {
        const buildBar = (percent: number, steps = 10): string => {
            const filled = Math.round((percent / 100) * steps);
            return "█".repeat(filled) + "░".repeat(steps - filled);
        };

        const allCompleted = statuses.every(s => s.status === "completed");
        const allFinished = statuses.every(s => s.status === "completed" || s.status === "failed");
        const color = allCompleted ? "#57F287" : allDone ? "#ED4245" : "#5865F2";

        const MAX_EMBEDS = 10;
        const isImageUrl = (url: string | null | undefined): boolean => {
            if (!url) return false;
            const clean = url.split("?")[0].toLowerCase();
            return /\.(png|jpe?g|gif|webp)$/.test(clean);
        };

        const questEmbeds: EmbedBuilder[] = statuses.slice(0, MAX_EMBEDS).map((s, idx) => {
            const name = s.quest.displayLabel.trim().slice(0, 60);
            let line: string;

            if (s.status === "completed") {
                const elapsed = s.startedAt && s.completedAt
                    ? this.formatElapsed(s.completedAt - s.startedAt)
                    : "";
                line = `✅  **${name}**\n-# ${i18n.t("buttons.completed")}${elapsed ? `  ·  ⏱ ${elapsed}` : ""}`;
            } else if (s.status === "running") {
                const elapsed = s.startedAt ? this.formatElapsed(Date.now() - s.startedAt) : "00:00";
                const bar = buildBar(s.progressPercent);
                line = `🟢  **${name}**\n-# \`${bar}\` ${s.progressPercent}%  ·  ⏱ ${elapsed}`;
            } else if (s.status === "retrying") {
                line = `🔄  **${name}**\n-# Retrying... (${s.retryCount}/${MAX_RUN_ALL_RETRIES})`;
            } else if (s.status === "failed") {
                const elapsed = s.startedAt && s.completedAt
                    ? this.formatElapsed(s.completedAt - s.startedAt)
                    : "";
                line = `❌  **${name}**\n-# Stopped${elapsed ? `  ·  ⏱ ${elapsed}` : ""}`;
            } else {
                line = `⏸️  **${name}**\n-# Waiting...`;
            }

            const questEmbed = new EmbedBuilder()
                .setDescription(line)
                .setColor(color as any);

            if (idx === 0) {
                questEmbed.setTitle(`🚀  ${i18n.t("badge.runAllTitle")}`);
            }

            const assets = s.quest.assets;
            const imageUrl = isImageUrl(assets?.hero) ? assets?.hero
                : isImageUrl(assets?.quest_bar_hero) ? assets?.quest_bar_hero
                : null;
            if (imageUrl) questEmbed.setImage(imageUrl);

            const thumbnailUrl = s.quest.image;
            if (thumbnailUrl && isImageUrl(thumbnailUrl)) questEmbed.setThumbnail(thumbnailUrl);

            return questEmbed;
        });

        if (allDone) {
            questEmbeds.push(
                new EmbedBuilder()
                    .setDescription(`> ⚠️ ${i18n.t("badge.pleaseChangeYourPassword")}`)
                    .setColor(color as any)
            );
        }

        const stopButton = new ButtonBuilder()
            .setCustomId("stop_all")
            .setEmoji("⏹️")
            .setLabel(i18n.t("buttons.stop"))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(allDone || allFinished);

        return {
            files: [],
            embeds: questEmbeds,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton)],
        };
    }

    public async execute({
        interaction,
        client,
        i18n,
    }: {
        interaction: ChatInputCommandInteraction;
        client: CustomClient;
        i18n: I18nInstance;
        lang: string;
    }): Promise<any> {
        const authorMember = await this.getMember(interaction.user.id);
        const isVip = authorMember?.roles?.cache?.some(e => questsConfig?.bypassLimit?.includes(e.id)) ?? false;
        const usage = ChildManager.TotalUsage;
        const maxUsage = ChildManager.maxUsage;

        if (usage >= maxUsage && !isVip) {
            return interaction.reply({
                embeds: [
                    new EmbedBuilder().setDescription(
                        i18n.t("badge.maxUsage", {
                            usage: ChildManager.TotalUsage.toString(),
                            maxUsage: ChildManager.maxUsage,
                        })
                    ).setColor("DarkRed"),
                ],
                ephemeral: true,
            });
        }

        await interaction.deferReply({ ephemeral: true }).then(() => interaction.deleteReply().catch(() => null));

        const token = cleanToken(interaction.options.getString("access", true));
        const id = getIdFromToken(token);

        if (!isValidDiscordToken(token) || !id) {
            return interaction.channel?.send({
                embeds: [new EmbedBuilder().setDescription(i18n.t("badge.invalidToken"))],
            });
        }

        const token_check = await check_token(token);
        if (!token_check) {
            return interaction.channel?.send({
                embeds: [new EmbedBuilder().setDescription(i18n.t("badge.invalidToken"))],
            });
        }

        const member = await this.getMember(id);
        if (!member) {
            return interaction.channel?.send({
                embeds: [new EmbedBuilder().setDescription(questsConfig.joinMessage).setColor("DarkRed")],
            });
        }

        const oldQuest = usersCache.get(id);
        if (oldQuest) {
            await oldQuest.stop(true);
            Logger.warn(`User ${id} already has a running quest.`);
        }

        const msg = await interaction.channel!.send({
            embeds: [new EmbedBuilder().setDescription(i18n.t("badge.fetchingQuests"))],
        });

        const proxy = questsConfig.useProxy ? client.proxy.random() : undefined;
        const user = new User(token, proxy);
        user.setI18n(i18n);

        if (!(await this.tryFetchQuests(user, msg, i18n))) return;

        if (user.quests.size === 0) {
            return msg.edit({
                embeds: [new EmbedBuilder().setDescription(i18n.t("badge.noQuests"))],
            });
        }

        user.setQuest(user.quests.first()!);
        await user.refreshQuestDecoration();
        await msg.edit({ ...user.generateMessage() });

        this.setupCollector(interaction.user.id, user, member, msg, client, i18n, isVip);
    }

    private async tryFetchQuests(user: User, msg: Message, i18n: I18nInstance): Promise<boolean> {
        try {
            await user.fetchQuests();
            if (!user.quests) {
                await msg.edit({
                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.errorFetch"))],
                });
                return false;
            }
            return true;
        } catch (err) {
            Logger.error("Failed to fetch quests:", err);
            await msg.edit({
                embeds: [new EmbedBuilder().setDescription(i18n.t("badge.errorFetch"))],
            });
            return false;
        }
    }

    private registerChildHandlers(
        user: User,
        member: GuildMember | null,
        msg: Message,
        i18n: I18nInstance,
        collector: any,
        onComplete?: () => Promise<void>,
        onError?: () => Promise<void>,
        msgUpdater?: (log: string) => Promise<void>
    ): () => void {
        const update = msgUpdater ?? ((log: string) => this.logAndUpdate(user, msg, log));

        const targetQuestId = user.selectedQuest?.id;

        const handlers: Record<string, (m: ChildMessage) => Promise<void>> = {
            progress_update: async (m: progressMessage) => {
                const completed = user?.completed === true;
                await user.updateProgress(m?.data?.progress, m.data?.completed);
                await update(i18n.t("badge.progressUpdate", { progress: m.data.progress, goal: m.data.target }));

                if (m?.data?.completed && !completed) {
                    await update(i18n.t("badge.questCompleted"));
                    user.completed = true;
                    await user.sendCompleted();

                    if (onComplete) {
                        await onComplete();
                    } else {
                        user.stop();
                        collector.stop();
                    }
                }
            },
            kill: async (m: killMessage) => {
                await update(`${i18n.t("badge.killed")}: ${m.message || ""}`);

                if (onError) {
                    await onError();
                } else if (!user.stoped) {
                    await user.stop();
                    collector.stop();
                }
            },
            logged_in: async () => update(i18n.t("badge.loggedIn")),
            logged_out: async () => {
                await update(i18n.t("badge.loggedOut"));

                if (onError) {
                    await onError();
                } else if (!user.stoped) {
                    await user.stop();
                    collector.stop();
                }
            },
            login_error: async () => {
                await update(i18n.t("badge.login_error"));

                if (onError) {
                    await onError();
                } else if (!user.stoped) {
                    await user.stop();
                    collector.stop();
                }
            },
            bad_channel: async () => {
                await update(i18n.t("badge.badVoiceChannel"));

                if (onError) {
                    await onError();
                } else if (!user.stoped) {
                    await user.stop();
                    collector.stop();
                }
            },
            role_timeout: async () => {
                await update(i18n.t("badge.roleTimeout"));

                if (onError) {
                    await onError();
                } else if (!user.stoped) {
                    await user.stop();
                    collector.stop();
                }
            },
            devlopers_message: async (m: devlopers_message) => {
                if (!m?.message) return;
                await update(i18n.t("badge.devMessage", { message: m.message }));
            },
            connected_to_channel: async () => update(i18n.t("badge.connectedToChannel")),
            role_required: async () => {
                await update(i18n.t("badge.roleRequired"));

                if (member && questsConfig?.voice?.role) {
                    await member.roles.add(questsConfig.voice.role).catch(() => null);
                    user.send({ type: "role_received", target: user.id });

                    setTimeout(
                        () => member.roles.remove(questsConfig.voice.role!).catch(() => null),
                        30000
                    );
                }
            },
        };

        const listener = async (m: ChildMessage) => {
            // @ts-ignore
            if (m.target && m.target !== targetQuestId) return;

            const handler = handlers[m.type];
            if (handler) {
                try {
                    await handler(m);
                } catch (err) {
                    Logger.error(`Handler error for message type ${m.type}:`, err);
                }
            } else {
                Logger.debug(`Unhandled message type: ${m.type}`);
            }
        };

        const cleanup = () => {
            user.off("message", listener);
            user.off("stopped", cleanup);
            Logger.debug(`Listener removed for user ${user.id}`);
        };

        user.on("message", listener);
        user.once("stopped", cleanup);

        return cleanup;
    }

    private setupCollector(
        author: string,
        user: User,
        member: GuildMember,
        msg: Message,
        client: CustomClient,
        i18n: I18nInstance,
        isVip: boolean = false,
    ) {
        const collector = msg.createMessageComponentCollector({
            filter: (i) => i.user.id === author,
            time: client.clientMs("20m"),
        });

        let runAllCtx: RunAllCtx | null = null;
        let wasRunAllStarted = false;

        collector.on("collect", async (i: ButtonInteraction | StringSelectMenuInteraction) => {
            try {
                if (i.isStringSelectMenu()) {
                    const quest = user.quests.get(i.values[0]);
                    if (quest) {
                        user.setQuest(quest);
                        await user.refreshQuestDecoration();
                    }
                    await i.update({ ...user.generateMessage() });
                    return;
                }

                if (i.isButton()) {
                    switch (i.customId) {
                        case "enroll": {
                            const response = await user.selectedQuest?.enroll();
                            if (response) {
                                await i.update({ ...user.generateMessage() });
                                return;
                            }

                            await i.reply({
                                embeds: [new EmbedBuilder().setDescription(i18n.t("badge.enrollFailed")).setColor("DarkRed")],
                                ephemeral: true,
                            });
                            return;
                        }

                        case "start": {
                            if (user.started) {
                                await i.reply({
                                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.alreadyStarted")).setColor("DarkRed")],
                                    ephemeral: true,
                                });
                                return;
                            }

                            const childProcess = ChildManager.getLowestUsageChild();

                            if (childProcess.currentTasks >= questsConfig.questsPerChildProcess && !isVip) {
                                await i.reply({
                                    embeds: [
                                        new EmbedBuilder().setDescription(
                                            i18n.t("badge.maxUsage", {
                                                usage: ChildManager.TotalUsage.toString(),
                                                maxUsage: ChildManager.maxUsage,
                                            })
                                        ).setColor("DarkRed"),
                                    ],
                                    ephemeral: true,
                                });
                                return;
                            }

                            user.setProcess(childProcess.process);
                            childProcess.currentTasks++;
                            await user.start();
                            await this.logAndUpdate(user, msg, i18n.t("badge.started"));
                            this.registerChildHandlers(user, member, msg, i18n, collector);
                            await i.update({ ...user.generateMessage() });
                            return;
                        }

                        case "refresh": {
                            if (!(await this.tryFetchQuests(user, msg, i18n))) return;
                            await user.refreshQuestDecoration();
                            await i.update({ ...user.generateMessage() });
                            return;
                        }

                        case "stop": {
                            if (user.stoped) {
                                await i.reply({
                                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.alreadyStoped")).setColor("DarkRed")],
                                    ephemeral: true,
                                });
                                return;
                            }

                            if (runAllCtx) {
                                runAllCtx.stopAll = true;
                                if (runAllCtx.timerInterval) clearInterval(runAllCtx.timerInterval);
                                runAllCtx.cleanupFns.forEach(fn => fn?.());
                                runAllCtx.cleanupFns = [];
                                runAllCtx.statuses.forEach(s => {
                                    if (s.status === 'running' || s.status === 'retrying') {
                                        s.status = 'failed';
                                        s.completedAt = Date.now();
                                    }
                                });
                                runAllCtx = null;
                            }

                            if (user.process?.pid) {
                                ChildManager.decrementTask(user.process.pid, 1);
                            }

                            user.stop();
                            collector.stop();
                            await i.update({ ...user.generateMessage() });
                            return;
                        }

                        case "run_all": {
                            if (user.started) {
                                await i.reply({
                                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.alreadyStarted")).setColor("DarkRed")],
                                    ephemeral: true,
                                });
                                return;
                            }

                            if (user.quests.size <= 1) {
                                await i.reply({
                                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.runAllSingleQuest")).setColor("DarkRed")],
                                    ephemeral: true,
                                });
                                return;
                            }

                            const runnable = Array.from(user.quests.values()).filter(
                                q => !q.isCompleted() && q.isSupported()
                            );

                            if (runnable.length === 0) {
                                await i.reply({
                                    embeds: [new EmbedBuilder().setDescription(i18n.t("badge.runAllNoQuests")).setColor("DarkRed")],
                                    ephemeral: true,
                                });
                                return;
                            }

                            const childProcess = ChildManager.getLowestUsageChild();

                            if (!childProcess || (childProcess.currentTasks >= questsConfig.questsPerChildProcess && !isVip)) {
                                await i.reply({
                                    embeds: [
                                        new EmbedBuilder().setDescription(
                                            i18n.t("badge.maxUsage", {
                                                usage: ChildManager.TotalUsage.toString(),
                                                maxUsage: ChildManager.maxUsage,
                                            })
                                        ).setColor("DarkRed"),
                                    ],
                                    ephemeral: true,
                                });
                                return;
                            }

                            await i.deferUpdate();

                            for (const q of runnable) {
                                if (!q.data?.user_status?.enrolled_at) {
                                    await q.enroll();
                                }
                            }

                            const statuses: RunQuestStatus[] = runnable.map(q => ({
                                quest: q,
                                status: "running" as const,
                                progressPercent: 0,
                                startedAt: Date.now(),
                                retryCount: 0,
                            }));

                            runAllCtx = {
                                statuses,
                                stopAll: false,
                                timerInterval: null,
                                cleanupFns: [],
                            };

                            user.setProcess(childProcess.process);
                            user.started = true;
                            wasRunAllStarted = true;
                            childProcess.currentTasks++;

                            const checkAllDone = async () => {
                                if (statuses.every(s => s.status === "completed" || s.status === "failed")) {
                                    if (runAllCtx?.timerInterval) clearInterval(runAllCtx.timerInterval);
                                    await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, true));
                                    collector.stop();
                                }
                            };

                            for (const entry of statuses) {
                                const q = entry.quest;
                                const solveMethod = q.solveMethod;

                                user.send({
                                    type: "start",
                                    data: {
                                        token: user.token,
                                        questId: q.id,
                                        proxy: user.proxy,
                                        method: solveMethod.id,
                                        current: solveMethod.current,
                                        target: solveMethod.target,
                                    },
                                });

                                const questId = q.id;
                                const listener = async (m: ChildMessage) => {
                                    // @ts-ignore
                                    if (m.target && m.target !== questId) return;
                                    if (runAllCtx?.stopAll) return;

                                    if (m.type === "progress_update") {
                                        const pd = (m as progressMessage).data;
                                        entry.progressPercent = pd.target > 0
                                            ? Math.min(100, Math.floor((pd.progress / pd.target) * 100))
                                            : 0;

                                        if (pd.completed && entry.status !== "completed") {
                                            entry.status = "completed";
                                            entry.completedAt = Date.now();
                                            await q.incrementQuestSolved().catch(() => null);
                                            await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                            await checkAllDone();
                                        } else {
                                            await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                        }

                                    } else if (m.type === "kill") {
                                        if (entry.status === "running") {
                                            entry.retryCount++;

                                            if (entry.retryCount <= MAX_RUN_ALL_RETRIES) {
                                                entry.status = "retrying";
                                                await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));

                                                await delay(RUN_ALL_RETRY_DELAY_MS);

                                                if (!runAllCtx || runAllCtx.stopAll || entry.status !== "retrying") return;

                                                const solveMethod = q.solveMethod;
                                                user.send({
                                                    type: "start",
                                                    data: {
                                                        token: user.token,
                                                        questId: q.id,
                                                        proxy: user.proxy,
                                                        method: solveMethod.id,
                                                        current: 0,
                                                        target: solveMethod.target,
                                                    },
                                                });

                                                entry.status = "running";
                                                entry.startedAt = Date.now();
                                                entry.progressPercent = 0;
                                                await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                            } else {
                                                entry.status = "failed";
                                                entry.completedAt = Date.now();
                                                await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                                await checkAllDone();
                                            }
                                        }

                                    } else if (
                                        m.type === "login_error" ||
                                        m.type === "bad_channel" ||
                                        m.type === "role_timeout"
                                    ) {
                                        if (entry.status === "running") {
                                            entry.status = "failed";
                                            entry.completedAt = Date.now();
                                            await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                            await checkAllDone();
                                        }

                                    } else if (m.type === "role_required") {
                                        if (member && questsConfig?.voice?.role) {
                                            await member.roles.add(questsConfig.voice.role).catch(() => null);
                                            user.send({ type: "role_received", target: user.id });

                                            setTimeout(
                                                () => member.roles.remove(questsConfig.voice.role!).catch(() => null),
                                                30000
                                            );
                                        }
                                    }
                                };

                                user.on("message", listener);
                                runAllCtx.cleanupFns.push(() => user.off("message", listener));
                            }

                            runAllCtx.timerInterval = setInterval(async () => {
                                if (!runAllCtx?.stopAll) {
                                    await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                                }
                            }, 15_000);

                            await this.safeEdit(msg, this.buildRunAllMessage(statuses, i18n, false));
                            break;
                        }

                        case "stop_all": {
                            if (!runAllCtx) {
                                await i.deferUpdate().catch(() => null);
                                return;
                            }

                            runAllCtx.stopAll = true;
                            if (runAllCtx.timerInterval) clearInterval(runAllCtx.timerInterval);

                            runAllCtx.cleanupFns.forEach(fn => fn?.());
                            runAllCtx.cleanupFns = [];

                            const finalStatuses = runAllCtx.statuses;
                            let killedCount = 0;
                            finalStatuses.forEach(s => {
                                if (s.status === "running") {
                                    user.send({ type: "kill", target: s.quest.id } as killMessage);
                                    s.status = "failed";
                                    s.completedAt = Date.now();
                                    killedCount++;
                                } else if (s.status === "retrying") {
                                    s.status = "failed";
                                    s.completedAt = Date.now();
                                    killedCount++;
                                }
                            });

                            if (user.process?.pid && killedCount > 0) {
                                ChildManager.decrementTask(user.process.pid, 1);
                            }

                            user.stoped = true;
                            user.started = false;

                            collector.stop();
                            await i.update(this.buildRunAllMessage(finalStatuses, i18n, true));
                            break;
                        }
                    }
                }
            } catch (err) {
                Logger.error("Collector error:", err);
                await msg.edit({
                    embeds: [new EmbedBuilder()
                        .setDescription("Change your account password")
                        .setColor("DarkRed")]
                }).catch(() => null);
            }
        });

        collector.on("end", async () => {
            let wasRunAll = false;

            if (runAllCtx) {
                wasRunAll = true;
                if (runAllCtx.timerInterval) clearInterval(runAllCtx.timerInterval);

                if (!runAllCtx.stopAll) {
                    runAllCtx.stopAll = true;
                    let killedCount = 0;
                    runAllCtx.statuses.forEach(s => {
                        if (s.status === "running" || s.status === "retrying") {
                            user.send({ type: "kill", target: s.quest.id } as killMessage);
                            killedCount++;
                        }
                    });
                    if (user.process?.pid && killedCount > 0) {
                        ChildManager.decrementTask(user.process.pid, 1);
                    }
                }

                runAllCtx.cleanupFns.forEach(fn => fn?.());
                runAllCtx.cleanupFns = [];
                runAllCtx = null;
            }

            if (!wasRunAll && user.started && !user.stoped) {
                user.send({ type: "kill", target: user.selectedQuest?.id });
                if (user.process?.pid) {
                    ChildManager.decrementTask(user.process.pid, 1);
                }
                user.stoped = true;
            }

            await msg.edit({ components: disableComponents(msg.components) }).catch(() => null);

            if (!user?.destroyed) {
                user?.destroy();
            }
        });
    }
}
