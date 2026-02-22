
// Erlandi Security - Cloudflare Workers + grammY
// Full Admin Version

import { Bot, webhookCallback, InlineKeyboard } from "grammy";

type Env = {
  BOT_TOKEN: string;
  OWNER_ID: string;
  KV: KVNamespace;
};

const BOT_NAME = "Erlandi Security";

function isAdminOrCreator(status?: string) {
  return status === "administrator" || status === "creator";
}

function isOwner(ctx: any, env: Env) {
  return String(ctx.from?.id) === String(env.OWNER_ID);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {

    if (!env.BOT_TOKEN)
      return new Response("BOT_TOKEN missing", { status: 500 });

    if (!env.KV)
      return new Response("KV binding missing (binding name must be 'KV')", { status: 500 });

    const bot = new Bot(env.BOT_TOKEN);

    bot.command("ping", async (ctx) => {
      await ctx.reply("Pong! Bot aktif.");
    });

    bot.command("owner", async (ctx) => {
      if (!isOwner(ctx, env)) return ctx.reply("Owner only.");
      await ctx.reply("Kamu owner bot.");
    });

    bot.command("help", async (ctx) => {
      const kb = new InlineKeyboard()
        .text("⚙️ Panel", "panel")
        .row()
        .text("📜 Rules", "rules");

      await ctx.reply(
        `🛡️ ${BOT_NAME}

Gunakan /panel untuk admin settings.`,
        { reply_markup: kb }
      );
    });

    bot.command("panel", async (ctx) => {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (!isAdminOrCreator(member.status))
        return ctx.reply("Admin only.");

      const kb = new InlineKeyboard()
        .text("AntiLink", "antilink")
        .row()
        .text("LockMedia", "lockmedia")
        .row()
        .text("AutoDelCmd", "autodel");

      await ctx.reply("Panel Settings:", { reply_markup: kb });
    });

    const url = new URL(req.url);
    if (url.pathname === "/webhook") {
      return webhookCallback(bot, "cloudflare-mod")(req);
    }

    return new Response("OK");
  },
};
