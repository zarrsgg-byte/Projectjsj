import { Client, Collection } from "discord.js";
import { QuestConfig } from "../lib/questConfig.js";
import { loadQuests, sendToProcess } from "./tools.js";
import { ChildMessage } from "../interface/ChildMessage.js";
import { getIdFromToken } from "../utils/quest/tokenUtils.js";
import { ChildUser } from "./childUser.js";

const questsConfigs = new Collection<string, QuestConfig>();
export const clients = new Collection<string, ChildUser>();

// --- Error Handlers ---
process.on("uncaughtException", (err) => {
    console.error(`[Worker ${process.pid}] Uncaught Exception:`, err);
    process.send?.({
        type: "ERROR",
        error: `Uncaught Exception: ${err.message}`,
        stack: err.stack,
    });
});

process.on("unhandledRejection", (reason, promise) => {
    console.error(
        `[Worker ${process.pid}] Unhandled Rejection at:`,
        promise,
        "reason:",
        reason
    );
    process.send?.({
        type: "ERROR",
        error: `Unhandled Rejection: ${String(reason)}`,
    });
});

const uniqueUserCount = () => new Set([...clients.values()].map(c => c.id)).size;

export const addClient = (client: ChildUser) => {
    clients.set(client.quest, client);
    sendToProcess({
        type: "process_update",
        count: uniqueUserCount(),
    });
};

export const removeClient = (client: ChildUser) => {
    if (!client?.quest) return;
    if (!clients.has(client.quest)) return;
    clients.delete(client.quest);
    client.destroy();
    sendToProcess({
        type: "process_update",
        count: uniqueUserCount(),
    });
};

// Async bootstrap
(async () => {
    await loadQuests(questsConfigs);
    console.log(`[Worker ${process.pid}] Quests loaded, ready for tasks.`);

    sendToProcess({ type: "ready" });

    process.on("message", async (msg: ChildMessage) => {
        try {
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case "start": {
                    const { data } = msg;
                    const { token, method, questId, proxy, current, target } = data;
                    if (clients.has(questId)) {
                        console.warn(`[Worker ${process.pid}] Quest ${questId} is already being processed.`);
                        return;
                    }
                    const questConfig = questsConfigs.get(method);
                    if (!questConfig) {
                        console.error(`[Worker ${process.pid}] Quest method ${method} not found.`);
                        sendToProcess?.({
                            type: "ERROR",
                            error: `Quest method ${method} not found.`,
                        });
                        return;
                    }
                    const client = new ChildUser(token, proxy, questId, questConfig, current, target);
                    addClient(client);
                    client.start();
                    break;
                }

                case "kill": {
                    const { target } = msg;
                    if (!target) return;
                    const user = clients.get(target);
                    if (user) {
                        user.stop();
                        removeClient(user);
                        console.log(`[Worker ${process.pid}] Stopped quest ${target}.`);
                    } else {
                        console.warn(`[Worker ${process.pid}] No active process found for quest ${target}.`);
                    }
                    break;
                }
            }
        } catch (err: any) {
            console.error(`[Worker ${process.pid}] Error while handling message:`, err);
            sendToProcess?.({
                type: "ERROR",
                error: err.message ?? String(err),
            });
        }
    });

    setInterval(() => { }, 1 << 30);
})();
