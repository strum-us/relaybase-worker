import { putSchedules, scriptSchedules } from "./cf-deploy";

/** Mail index maintenance (src/lib/mail/inbound-index-cron.ts). */
export const INDEX_CRON = "*/15 * * * *";
/** Self-update (schedule.ts). Same expression as the app's install pipeline. */
export const UPDATE_CRON = "*/30 * * * *";

/** Add the update Cron Trigger next to any the script already has. */
export async function ensureUpdateSchedule(token: string, accountId: string, scriptName: string): Promise<void> {
  const crons = await scriptSchedules(token, accountId, scriptName);
  if (crons.includes(UPDATE_CRON)) return;
  await putSchedules(token, accountId, scriptName, [...crons, UPDATE_CRON]);
}
