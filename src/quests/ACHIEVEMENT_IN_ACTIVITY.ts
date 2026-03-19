import { ChildUser } from "../childProcess/childUser.js";
import { QuestConfig } from "../lib/questConfig.js";
import ms from "ms";

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 10_000;

export default new QuestConfig({
    name: "ACHIEVEMENT_IN_ACTIVITY",
    requireLogin: false,
    requireVoiceChannel: false,

    async run(user: ChildUser) {
        let progress = user.current || 0;
        const targetCount = user.target;
        const streamKey = `call:${user.quest}:1`;
        let consecutiveFailures = 0;

        while (!user.stoped) {
            const heartbeat = await user.api
                .post(`/quests/${user.quest}/heartbeat`, {
                    stream_key: streamKey,
                    terminal: false,
                })
                .catch((err) => err?.response);

            if (!heartbeat?.data?.user_id) {
                consecutiveFailures++;
                const status = heartbeat?.status ?? "no response";
                const detail = JSON.stringify(heartbeat?.data ?? {});
                console.warn(
                    `[ACHIEVEMENT_IN_ACTIVITY] Heartbeat failed (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — status: ${status}, body: ${detail}`
                );

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    user.stop(`Error sending heartbeat after ${MAX_CONSECUTIVE_FAILURES} attempts (last status: ${status})`);
                    break;
                }

                await user.delay(RETRY_DELAY_MS);
                continue;
            }

            consecutiveFailures = 0;

            const response = user.extractProgress(heartbeat.data);
            progress = response.value;
            user.sendUpdate(progress, response.completed === true);

            if (progress >= targetCount || response.completed === true) {
                user.stop();
                user.completed = true;
                break;
            }

            await user.delay(ms("30s"));
        }
    },
});
