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
    const bot = new Bot(env.BOT_TOKEN);

    // ===== KV helpers =====
    const kvGetBool = async (key: string, def = false) => {
      const v = await env.KV.get(key);
      if (v === null) return def;
      return v === "1";
    };
    const kvSetBool = async (key: string, v: boolean) => env.KV.put(key, v ? "1" : "0");
    const kvGetInt = async (key: string, def = 0) => {
      const v = await env.KV.get(key);
      if (!v) return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const kvSetInt = async (key: string, v: number) => env.KV.put(key, String(v));

    async function requireAdmin(ctx: any): Promise<boolean> {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (!chatId || !userId) return false;

      try {
        const m = await ctx.api.getChatMember(chatId, userId);
        if (!isAdminOrCreator(m.status)) {
          await ctx.reply("❌ Perintah ini hanya untuk admin grup.");
          return false;
        }
        return true;
      } catch {
        await ctx.reply("❌ Gagal cek admin. Pastikan bot jadi admin di grup.");
        return false;
      }
    }

    async function requireOwner(ctx: any): Promise<boolean> {
      if (!isOwner(ctx, env)) {
        await ctx.reply("❌ Perintah ini hanya untuk owner bot.");
        return false;
      }
      return true;
    }

    function getTargetUserId(ctx: any): number | null {
      const replyFrom = ctx.msg?.reply_to_message?.from?.id;
      if (replyFrom) return replyFrom;

      const arg = String(ctx.match || "").trim();
      if (arg && /^\d+$/.test(arg)) return Number(arg);
      return null;
    }

    function buildPanelKeyboard(state: {
      welcome: boolean;
      antilink: boolean;
      lockmedia: boolean;
      autodel: boolean;
      antiflood: boolean;
    }) {
      const k = new InlineKeyboard()
        .text(`Welcome: ${state.welcome ? "ON" : "OFF"}`, "tgl:welcome")
        .text(`AntiLink: ${state.antilink ? "ON" : "OFF"}`, "tgl:antilink")
        .row()
        .text(`LockMedia: ${state.lockmedia ? "ON" : "OFF"}`, "tgl:lockmedia")
        .text(`AutoDelCmd: ${state.autodel ? "ON" : "OFF"}`, "tgl:autodel")
        .row()
        .text(`AntiFlood: ${state.antiflood ? "ON" : "OFF"}`, "tgl:antiflood")
        .row()
        .text("Refresh", "panel:refresh");
      return k;
    }

    // ===== In-memory flood tracker (best-effort) =====
    // Note: Workers are stateless; this works per isolate. Good enough for basic flood protection.
    const floodMap = new Map<string, { ts: number[] }>();
    const now = () => Date.now();

    async function checkFlood(ctx: any): Promise<boolean> {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (!chatId || !userId) return false;

      const enabled = await kvGetBool(`antiflood:${chatId}`, true);
      if (!enabled) return false;

      const windowSec = await kvGetInt(`flood_window:${chatId}`, 10);
      const limit = await kvGetInt(`flood_limit:${chatId}`, 6);
      const key = `${chatId}:${userId}`;

      const wms = Math.max(3, Math.min(windowSec, 60)) * 1000;
      const t = now();

      const entry = floodMap.get(key) || { ts: [] };
      entry.ts = entry.ts.filter((x) => t - x <= wms);
      entry.ts.push(t);
      floodMap.set(key, entry);

      if (entry.ts.length > limit) {
        // Action: mute 1 minute + delete current message if possible
        try {
          await ctx.deleteMessage();
        } catch {}

        const until = Math.floor(Date.now() / 1000) + 60;
        try {
          await ctx.api.restrictChatMember(chatId, userId, {
            permissions: {
              can_send_messages: false,
              can_send_audios: false,
              can_send_documents: false,
              can_send_photos: false,
              can_send_videos: false,
              can_send_video_notes: false,
              can_send_voice_notes: false,
              can_send_polls: false,
              can_send_other_messages: false,
              can_add_web_page_previews: false,
              can_change_info: false,
              can_invite_users: false,
              can_pin_messages: false,
              can_manage_topics: false,
            },
            until_date: until,
          });
        } catch {}

        return true;
      }

      return false;
    }

    // ===== Auto-moderation middleware =====
    bot.on("message", async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return next();

      // anti-flood (best-effort)
      const flooded = await checkFlood(ctx);
      if (flooded) return;

      const text = ctx.message?.text || ctx.message?.caption || "";

      // antilink
      const antilink = await kvGetBool(`antilink:${chatId}`, false);
      if (antilink && /(https?:\/\/|t\.me\/|www\.)/i.test(text)) {
        try {
          await ctx.deleteMessage();
          return;
        } catch {}
      }

      // lockmedia
      const lockmedia = await kvGetBool(`lockmedia:${chatId}`, false);
      if (lockmedia) {
        const hasMedia =
          !!ctx.message?.photo ||
          !!ctx.message?.video ||
          !!ctx.message?.document ||
          !!ctx.message?.audio ||
          !!ctx.message?.voice ||
          !!ctx.message?.animation ||
          !!ctx.message?.sticker;

        if (hasMedia) {
          try {
            await ctx.deleteMessage();
            return;
          } catch {}
        }
      }

      return next();
    });

    // ===== Auto-delete command messages (clean chat) =====
    bot.on("message:text", async (ctx, next) => {
      // only if it's a command
      const text = ctx.message.text || "";
      if (!text.startsWith("/")) return next();

      await next(); // process command first

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      // Default ON in groups
      const enabled = await kvGetBool(`autodelcmd:${chatId}`, true);
      if (!enabled) return;

      // Don't auto-delete in private chats
      if (ctx.chat?.type === "private") return;

      try {
        await ctx.deleteMessage();
      } catch {
        // ignore (needs delete permission)
      }
    });

    // ===== HELP / PANEL =====
    bot.command("help", async (ctx) => {
      const base =
        `🛡️ *${BOT_NAME}*\n\n` +
        "📌 *Member Commands*\n" +
        "• /ping\n" +
        "• /rules\n" +
        "• /cekid, /idgue\n" +
        "• /idtarget (reply pesan)\n" +
        "• /stikerinfo (reply sticker)\n" +
        "• /colongstiker (reply sticker)\n" +
        "• /warnings (cek warn kamu/target)\n";

      const admin =
        "\n🛡️ *Admin Commands*\n" +
        "• /panel (tombol setting)\n" +
        "• /setrules (reply teks)\n" +
        "• /welcome on|off\n" +
        "• /setwelcome (reply teks)\n" +
        "• /antilink on|off\n" +
        "• /lockmedia on|off\n" +
        "• /autodelcmd on|off\n" +
        "• /antiflood on|off\n" +
        "• /setflood <limit> <seconds>  (contoh: /setflood 6 10)\n" +
        "• /ban (reply/ID)\n" +
        "• /kick (reply/ID)\n" +
        "• /mute (reply/ID) [default 10m]\n" +
        "• /unmute (reply/ID)\n" +
        "• /purge (reply) atau /purge 20\n" +
        "• /warn (reply/ID)  (auto-ban 3 warn)\n" +
        "• /resetwarn (reply/ID)\n";

      const owner =
        "\n👑 *Owner Commands*\n" +
        "• /owner\n" +
        "• /leave (bot keluar chat ini)\n";

      let extra = "";
      try {
        if (ctx.chat?.id && ctx.from?.id) {
          const m = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
          if (isAdminOrCreator(m.status)) extra += admin;
        }
      } catch {}
      if (isOwner(ctx, env)) extra += owner;

      const kb = new InlineKeyboard()
        .text("📋 Rules", "nav:rules")
        .text("⚙️ Panel", "nav:panel")
        .row()
        .text("🆔 Cek ID", "nav:id")
        .text("🧩 Sticker", "nav:sticker");

      await ctx.reply(base + extra, { parse_mode: "Markdown", reply_markup: kb });
    });

    bot.command("panel", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const state = {
        welcome: await kvGetBool(`welcome_enabled:${chatId}`, false),
        antilink: await kvGetBool(`antilink:${chatId}`, false),
        lockmedia: await kvGetBool(`lockmedia:${chatId}`, false),
        autodel: await kvGetBool(`autodelcmd:${chatId}`, true),
        antiflood: await kvGetBool(`antiflood:${chatId}`, true),
      };

      const kb = buildPanelKeyboard(state);

      await ctx.reply(
        `⚙️ *${BOT_NAME} Panel*\nChat: ${ctx.chat?.title || chatId}\n\nKlik tombol untuk toggle fitur.`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    });

    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data || "";
      const chatId = ctx.chat?.id;
      if (!chatId) return ctx.answerCallbackQuery();

      // Only admins can toggle
      try {
        const m = await ctx.api.getChatMember(chatId, ctx.from.id);
        if (!isAdminOrCreator(m.status) && !isOwner(ctx, env)) {
          await ctx.answerCallbackQuery({ text: "Admin only.", show_alert: true });
          return;
        }
      } catch {
        await ctx.answerCallbackQuery({ text: "Tidak bisa cek admin.", show_alert: true });
        return;
      }

      const refresh = async () => {
        const state = {
          welcome: await kvGetBool(`welcome_enabled:${chatId}`, false),
          antilink: await kvGetBool(`antilink:${chatId}`, false),
          lockmedia: await kvGetBool(`lockmedia:${chatId}`, false),
          autodel: await kvGetBool(`autodelcmd:${chatId}`, true),
          antiflood: await kvGetBool(`antiflood:${chatId}`, true),
        };
        const kb = buildPanelKeyboard(state);
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: kb });
        } catch {}
      };

      if (data === "panel:refresh") {
        await refresh();
        await ctx.answerCallbackQuery({ text: "Refreshed." });
        return;
      }

      if (data.startsWith("tgl:")) {
        const key = data.slice(4);
        const map: Record<string, { k: string; def: boolean }> = {
          welcome: { k: `welcome_enabled:${chatId}`, def: false },
          antilink: { k: `antilink:${chatId}`, def: false },
          lockmedia: { k: `lockmedia:${chatId}`, def: false },
          autodel: { k: `autodelcmd:${chatId}`, def: true },
          antiflood: { k: `antiflood:${chatId}`, def: true },
        };
        const item = map[key];
        if (!item) {
          await ctx.answerCallbackQuery();
          return;
        }
        const cur = await kvGetBool(item.k, item.def);
        await kvSetBool(item.k, !cur);
        await refresh();
        await ctx.answerCallbackQuery({ text: `${key} => ${!cur ? "ON" : "OFF"}` });
        return;
      }

      if (data.startsWith("nav:")) {
        const page = data.slice(4);
        if (page === "rules") {
          const rules = await env.KV.get(`rules:${chatId}`);
          await ctx.answerCallbackQuery();
          await ctx.reply(rules ? `📜 Rules:\n${rules}` : "Rules belum diset. Admin pakai /setrules (reply).");
          return;
        }
        if (page === "panel") {
          await ctx.answerCallbackQuery();
          // trigger panel message
          await ctx.reply("Ketik /panel untuk buka panel setting (admin only).");
          return;
        }
        if (page === "id") {
          await ctx.answerCallbackQuery();
          await ctx.reply("Gunakan /cekid atau /idtarget (reply).");
          return;
        }
        if (page === "sticker") {
          await ctx.answerCallbackQuery();
          await ctx.reply("Gunakan /stikerinfo atau /colongstiker (reply sticker).");
          return;
        }
      }

      await ctx.answerCallbackQuery();
    });

    // ===== Member commands =====
    bot.command("ping", async (ctx) => {
      const start = Date.now();
      await ctx.reply(`Pong! ${Date.now() - start}ms`);
    });

    bot.command(["cekid", "idgue"], async (ctx) => {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      const msgId = ctx.msg?.message_id;
      await ctx.reply(`🆔 Info\n- user_id: ${userId}\n- chat_id: ${chatId}\n- message_id: ${msgId}`);
    });

    bot.command("idtarget", async (ctx) => {
      const r = ctx.msg?.reply_to_message;
      if (!r?.from) return ctx.reply("Reply pesan orangnya dulu.");
      await ctx.reply(`🆔 Target user_id: ${r.from.id}`);
    });

    bot.command("rules", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const rules = await env.KV.get(`rules:${chatId}`);
      await ctx.reply(rules ? `📜 Rules:\n${rules}` : "Rules belum diset. Admin pakai /setrules (reply).");
    });

    // ===== Sticker tools =====
    bot.command("stikerinfo", async (ctx) => {
      const st = ctx.msg?.reply_to_message?.sticker || ctx.msg?.sticker;
      if (!st) return ctx.reply("Reply sticker atau kirim sticker dengan caption /stikerinfo");

      const info =
        `🧩 Sticker Info\n` +
        `- file_id: ${st.file_id}\n` +
        (st.set_name ? `- set_name: ${st.set_name}\n` : "") +
        (st.emoji ? `- emoji: ${st.emoji}\n` : "") +
        (st.is_animated ? `- animated: yes\n` : `- animated: no\n`) +
        (st.is_video ? `- video: yes\n` : `- video: no\n`);

      await ctx.reply(info);
    });

    bot.command("colongstiker", async (ctx) => {
      const st = ctx.msg?.reply_to_message?.sticker;
      if (!st) return ctx.reply("Reply sticker yang mau dicuri/dikirim ulang.");
      await ctx.api.sendSticker(ctx.chat.id, st.file_id);
    });

    // ===== Warnings (member can check) =====
    bot.command("warnings", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx) || ctx.from.id;
      const count = await kvGetInt(`warn:${chatId}:${target}`, 0);
      await ctx.reply(`⚠️ Warnings untuk ${target}: ${count}/3`);
    });

    // ===== Admin config toggles =====
    bot.command("autodelcmd", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const arg = (ctx.match || "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") return ctx.reply("Pakai: /autodelcmd on|off");
      await kvSetBool(`autodelcmd:${chatId}`, arg === "on");
      await ctx.reply(`✅ Auto-delete command ${arg.toUpperCase()}`);
    });

    bot.command("antiflood", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const arg = (ctx.match || "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") return ctx.reply("Pakai: /antiflood on|off");
      await kvSetBool(`antiflood:${chatId}`, arg === "on");
      await ctx.reply(`✅ Anti-flood ${arg.toUpperCase()}`);
    });

    bot.command("setflood", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const parts = String(ctx.match || "").trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) return ctx.reply("Pakai: /setflood <limit> <seconds>  (contoh: /setflood 6 10)");

      const limit = Number(parts[0]);
      const windowSec = Number(parts[1]);
      if (!Number.isFinite(limit) || !Number.isFinite(windowSec) || limit < 2 || windowSec < 3) {
        return ctx.reply("Angka tidak valid. Contoh yang aman: /setflood 6 10");
      }

      await kvSetInt(`flood_limit:${chatId}`, Math.min(20, Math.floor(limit)));
      await kvSetInt(`flood_window:${chatId}`, Math.min(60, Math.floor(windowSec)));
      await ctx.reply(`✅ Flood set: limit=${Math.min(20, Math.floor(limit))} window=${Math.min(60, Math.floor(windowSec))}s`);
    });

    // ===== Admin rules/welcome/antilink/lockmedia =====
    bot.command("setrules", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      const r = ctx.msg?.reply_to_message;
      const text = r?.text || r?.caption;
      if (!chatId) return;
      if (!text) return ctx.reply("Gunakan /setrules dengan reply ke teks rules.");
      await env.KV.put(`rules:${chatId}`, text);
      await ctx.reply("✅ Rules disimpan.");
    });

    bot.command("welcome", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const arg = (ctx.match || "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") return ctx.reply("Pakai: /welcome on atau /welcome off");

      await kvSetBool(`welcome_enabled:${chatId}`, arg === "on");
      await ctx.reply(`✅ Welcome ${arg.toUpperCase()}`);
    });

    bot.command("setwelcome", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      const r = ctx.msg?.reply_to_message;
      const text = r?.text || r?.caption;
      if (!chatId) return;
      if (!text) return ctx.reply("Gunakan /setwelcome dengan reply ke teks template welcome.");
      await env.KV.put(`welcome_text:${chatId}`, text);
      await ctx.reply("✅ Template welcome disimpan. Placeholder: {name} {username} {id} {chat}");
    });

    bot.command("antilink", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const arg = (ctx.match || "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") return ctx.reply("Pakai: /antilink on|off");
      await kvSetBool(`antilink:${chatId}`, arg === "on");
      await ctx.reply(`✅ AntiLink ${arg.toUpperCase()}`);
    });

    bot.command("lockmedia", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const arg = (ctx.match || "").trim().toLowerCase();
      if (arg !== "on" && arg !== "off") return ctx.reply("Pakai: /lockmedia on|off");
      await kvSetBool(`lockmedia:${chatId}`, arg === "on");
      await ctx.reply(`✅ LockMedia ${arg.toUpperCase()}`);
    });

    // ===== Welcome event =====
    bot.on("chat_member", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const enabled = await kvGetBool(`welcome_enabled:${chatId}`, false);
      if (!enabled) return;

      const newMember = ctx.chatMember?.new_chat_member;
      if (newMember?.status !== "member") return;

      const tpl = (await env.KV.get(`welcome_text:${chatId}`)) || "Halo {name} 👋 Selamat datang di {chat}!";

      const name = [newMember.user.first_name, newMember.user.last_name].filter(Boolean).join(" ");
      const username = newMember.user.username ? `@${newMember.user.username}` : "";
      const msg = tpl
        .replaceAll("{name}", name)
        .replaceAll("{username}", username)
        .replaceAll("{id}", String(newMember.user.id))
        .replaceAll("{chat}", String(ctx.chat?.title || "grup"));

      await ctx.api.sendMessage(chatId, msg);
    });

    // ===== Admin moderation =====
    bot.command("ban", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply pesan target atau pakai: /ban <user_id>");

      try {
        await ctx.api.banChatMember(chatId, target);
        await ctx.reply(`✅ Banned: ${target}`);
      } catch {
        await ctx.reply("❌ Gagal ban. Pastikan bot punya izin Ban users.");
      }
    });

    bot.command("kick", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply pesan target atau pakai: /kick <user_id>");

      try {
        await ctx.api.banChatMember(chatId, target);
        await ctx.api.unbanChatMember(chatId, target);
        await ctx.reply(`✅ Kicked: ${target}`);
      } catch {
        await ctx.reply("❌ Gagal kick. Pastikan bot punya izin Ban users.");
      }
    });

    bot.command("mute", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply target atau: /mute <user_id> [10m|1h|1d]");

      const arg = String(ctx.match || "").trim().toLowerCase();
      const m = arg.match(/(\d+)\s*(m|h|d)\b/);
      let seconds = 10 * 60;
      if (m) {
        const n = Number(m[1]);
        const unit = m[2];
        seconds = unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
      }
      const until = Math.floor(Date.now() / 1000) + seconds;

      try {
        await ctx.api.restrictChatMember(chatId, target, {
          permissions: {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
            can_manage_topics: false,
          },
          until_date: until,
        });
        await ctx.reply(`✅ Muted: ${target} selama ~${Math.round(seconds / 60)} menit`);
      } catch {
        await ctx.reply("❌ Gagal mute. Pastikan bot punya izin Restrict members.");
      }
    });

    bot.command("unmute", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply target atau: /unmute <user_id>");

      try {
        await ctx.api.restrictChatMember(chatId, target, {
          permissions: {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_change_info: false,
            can_invite_users: true,
            can_pin_messages: false,
            can_manage_topics: false,
          },
        });
        await ctx.reply(`✅ Unmuted: ${target}`);
      } catch {
        await ctx.reply("❌ Gagal unmute. Pastikan bot punya izin Restrict members.");
      }
    });

    bot.command("purge", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      const msgId = ctx.msg?.message_id;
      if (!chatId || !msgId) return;

      const arg = String(ctx.match || "").trim();
      const count = arg && /^\d+$/.test(arg) ? Math.min(Number(arg), 100) : null;

      if (count) {
        for (let id = msgId; id > msgId - count; id--) {
          try {
            await ctx.api.deleteMessage(chatId, id);
          } catch {}
        }
        return;
      }

      const replyId = ctx.msg?.reply_to_message?.message_id;
      if (!replyId) return ctx.reply("Gunakan /purge dengan reply pesan, atau /purge <angka> (max 100).");

      const from = Math.max(replyId, msgId - 100);
      for (let id = msgId; id >= from; id--) {
        try {
          await ctx.api.deleteMessage(chatId, id);
        } catch {}
      }
    });

    // ===== Warn system + auto-ban at 3 =====
    bot.command("warn", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply target atau: /warn <user_id>");

      const key = `warn:${chatId}:${target}`;
      const cur = await kvGetInt(key, 0);
      const next = Math.min(cur + 1, 99);
      await kvSetInt(key, next);

      const reason = ctx.msg?.reply_to_message?.text
        ? ""
        : ""; // placeholder (optional)
      await ctx.reply(`⚠️ Warn untuk ${target}: ${next}/3` + reason);

      if (next >= 3) {
        try {
          await ctx.api.banChatMember(chatId, target);
          await ctx.reply(`⛔ Auto-ban: ${target} (3 warn)`);
        } catch {
          await ctx.reply("❌ Gagal auto-ban (cek izin bot).");
        }
      }
    });

    bot.command("resetwarn", async (ctx) => {
      if (!(await requireAdmin(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const target = getTargetUserId(ctx);
      if (!target) return ctx.reply("Reply target atau: /resetwarn <user_id>");
      await env.KV.delete(`warn:${chatId}:${target}`);
      await ctx.reply(`✅ Warn direset untuk ${target}`);
    });

    // ===== Owner only =====
    bot.command("owner", async (ctx) => {
      if (!(await requireOwner(ctx))) return;
      await ctx.reply("✅ Kamu adalah owner bot.");
    });

    bot.command("leave", async (ctx) => {
      if (!(await requireOwner(ctx))) return;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      await ctx.reply("👋 Oke, bot keluar dari chat ini.");
      await ctx.api.leaveChat(chatId);
    });

    // ===== Webhook route =====
    const url = new URL(req.url);
    if (url.pathname === "/webhook") {
      return webhookCallback(bot, "cloudflare-mod")(req);
    }
    return new Response("OK");
  },
};
