import { EventEmitter } from "events";
import { AxiosInstance } from "axios";
import { QuestConfig } from "../questConfig.js";
import { customAxiosWithProxy } from "../../utils/quest/axiosInstance.js";
import { Logger } from "../../core/logger.js";

export class SelfUserQuestRunner extends EventEmitter {
    token: string;
    id: string;
    quest: string;
    questConfig: QuestConfig;
    current: number;
    target: number;
    stoped: boolean = false;
    completed: boolean = false;
    started: boolean = false;

    private _api: AxiosInstance | null = null;
    private abortController: AbortController | null = null;
    private lastLoggedPercent: number = -1;

    constructor(
        token: string,
        id: string,
        questId: string,
        questConfig: QuestConfig,
        current: number,
        target: number
    ) {
        super();
        this.token = token;
        this.id = id;
        this.quest = questId;
        this.questConfig = questConfig;
        this.current = current;
        this.target = target;
    }

    get api(): AxiosInstance {
        if (!this._api) {
            this.abortController = new AbortController();
            this._api = customAxiosWithProxy(this.token, null);
            this._api.interceptors.request.use((cfg) => {
                if (this.abortController) cfg.signal = this.abortController.signal;
                return cfg;
            });
        }
        return this._api;
    }

    sendUpdate(progress: number, completedFlag: boolean): void {
        this.current = progress;
        if (completedFlag) {
            this.completed = true;
        }

        const percent = this.target > 0 ? Math.min(100, Math.floor((progress / this.target) * 100)) : 0;

        // Emit every 5% change or on completion
        if (completedFlag || percent >= this.lastLoggedPercent + 5 || this.lastLoggedPercent === -1) {
            this.lastLoggedPercent = percent;
            this.emit("progress", { current: progress, target: this.target, percent, completed: completedFlag });
        }
    }

    extractProgress(quest: any): { value: number; completed: boolean } {
        const progress = quest?.progress?.[this.questConfig.name];
        if (!progress) return { value: 0, completed: false };
        return {
            value: progress?.value ?? 0,
            completed: progress?.completed_at != null,
        };
    }

    stop(message: string = "Stopped"): void {
        if (this.stoped) return;
        this.stoped = true;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this._api = null;
        if (!this.completed) {
            this.emit("failed", message);
        }
    }

    async delay(time: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, time));
    }

    async run(): Promise<boolean> {
        if (this.started) return false;
        this.started = true;

        if (this.questConfig.requireLogin || this.questConfig.requireVoiceChannel) {
            Logger.warn(`[SelfUserRunner] Quest ${this.quest} requires login/voice — skipping`);
            this.stoped = true;
            this.emit("failed", "requires_login_or_voice");
            return false;
        }

        try {
            await this.questConfig.run(this as any);

            if (this.completed) {
                this.emit("completed");
                return true;
            } else {
                if (!this.stoped) this.emit("failed", "not_completed");
                return false;
            }
        } catch (err: any) {
            if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") {
                if (!this.stoped) this.emit("failed", "aborted");
            } else {
                Logger.error(`[SelfUserRunner] Quest ${this.quest} error:`, err);
                if (!this.stoped) this.emit("failed", String(err));
            }
            return false;
        } finally {
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
            this._api = null;
        }
    }
}
