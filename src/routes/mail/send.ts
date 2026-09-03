import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";
import { sendMailMessage, type SendMailBody } from "../../lib/mail/send-message";

const mailSend = new Hono<{ Bindings: Env }>();

/**
 * Desktop compose send (admin bearer). Same body as /v1/send, without API-key
 * domain scoping — from address must still be a real mailbox address.
 */
mailSend.post("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  let body: SendMailBody;
  try {
    body = (await c.req.json()) as SendMailBody;
  } catch {
    body = {};
  }

  const result = await sendMailMessage(c.env, body, "compose", {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
  return result.response;
});

export { mailSend };
