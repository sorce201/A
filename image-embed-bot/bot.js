// بوت ديسكورد: يعيد نشر أي صورة يرسلها عضو كصورة عادية (بدون Embed)
// التعليقات تظهر مباشرة في نص نفس الرسالة (تحت اسم العضو وفوق الصورة) وتكون مرئية للجميع
// بدون Embed وبدون Thread وبدون ردود منفصلة — كل شيء داخل نفس الرسالة الواحدة.

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// ================== إعدادات عامة ==================
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const REACTION_EMOJIS = (process.env.REACTION_EMOJIS || '👍,❤️,🔥,😂')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

const MAX_COMMENTS_SHOWN = 8; // كم تعليق تعرض بأعلى الرسالة قبل ما تصير طويلة

// تخزين مؤقت بالذاكرة (يُستحسن استبداله بقاعدة بيانات لاحقًا)
const commentsStore = new Map(); // messageId -> [{ userId, username, text, ts }]
const reactionsStore = new Map(); // messageId -> Map(emoji -> Set(userId))
const authorStore = new Map(); // messageId -> displayName صاحب الصورة

// ================== إنشاء العميل ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ البوت شغّال باسم ${c.user.tag}`);
});

// ================== بناء نص الرسالة (اسم العضو + التعليقات) ==================
function buildMessageContent(messageKey) {
  const displayName = authorStore.get(messageKey) || 'عضو';
  const comments = commentsStore.get(messageKey) || [];

  let content = `**${displayName}**`;

  if (comments.length > 0) {
    const shown = comments.slice(-MAX_COMMENTS_SHOWN);
    const hiddenCount = comments.length - shown.length;

    const commentLines = shown
      .map((c) => `> **${c.username}:** ${c.text}`)
      .join('\n');

    content += `\n\n💬 **التعليقات (${comments.length})**`;
    if (hiddenCount > 0) {
      content += ` — عرض آخر ${shown.length}`;
    }
    content += `\n${commentLines}`;
  }

  return content;
}

// ================== بناء الأزرار ==================
function buildActionRows(messageKey) {
  const commentRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_comment:${messageKey}`)
      .setLabel('➕ تعليق')
      .setStyle(ButtonStyle.Secondary)
  );

  const reactionsMap = reactionsStore.get(messageKey) || new Map();
  const reactionButtons = REACTION_EMOJIS.slice(0, 5).map((emoji) => {
    const count = reactionsMap.get(emoji)?.size || 0;
    return new ButtonBuilder()
      .setCustomId(`react:${messageKey}:${emoji}`)
      .setLabel(count > 0 ? `${emoji} ${count}` : emoji)
      .setStyle(ButtonStyle.Secondary);
  });

  const rows = [commentRow];
  if (reactionButtons.length) {
    rows.push(new ActionRowBuilder().addComponents(reactionButtons));
  }
  return rows;
}

// ================== استقبال الصور وإعادة نشرها كمرفق عادي (بدون Embed) ==================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (TARGET_CHANNEL_ID && message.channelId !== TARGET_CHANNEL_ID) return;

  const imageAttachments = [...message.attachments.values()].filter((a) =>
    (a.contentType || '').startsWith('image/')
  );
  if (imageAttachments.length === 0) return;

  try {
    const displayName = message.member?.displayName || message.author.username;

    for (const attachment of imageAttachments) {
      const file = new AttachmentBuilder(attachment.url, {
        name: attachment.name || 'image.png',
      });

      const sent = await message.channel.send({
        content: `**${displayName}**`,
        files: [file],
        components: buildActionRows('placeholder'), // مؤقت، سنحدّثه بعد إرسال الرسالة
      });

      // الآن نعرف معرّف الرسالة الفعلي — نخزّن صاحب الصورة ونبني الأزرار المرتبطة به
      authorStore.set(sent.id, displayName);
      const rows = buildActionRows(sent.id);
      await sent.edit({ content: buildMessageContent(sent.id), components: rows });
    }

    // حذف رسالة العضو الأصلية للحفاظ على القناة نظيفة (اختياري)
    if (message.deletable) {
      await message.delete().catch(() => {});
    }
  } catch (err) {
    console.error('خطأ أثناء إعادة نشر الصورة:', err);
  }
});

// ================== التعامل مع تفاعلات الأزرار ==================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const [action, messageKey, extra] = interaction.customId.split(':');

      if (action === 'add_comment') {
        const modal = new ModalBuilder()
          .setCustomId(`comment_modal:${messageKey}`)
          .setTitle('أضف تعليقك');

        const input = new TextInputBuilder()
          .setCustomId('comment_text')
          .setLabel('اكتب تعليقك هنا')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(300)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (action === 'react') {
        const emoji = extra;
        if (!reactionsStore.has(messageKey)) {
          reactionsStore.set(messageKey, new Map());
        }
        const emojiMap = reactionsStore.get(messageKey);
        if (!emojiMap.has(emoji)) emojiMap.set(emoji, new Set());
        const userSet = emojiMap.get(emoji);

        // تبديل التفاعل: إضافة أو إزالة
        if (userSet.has(interaction.user.id)) {
          userSet.delete(interaction.user.id);
        } else {
          userSet.add(interaction.user.id);
        }

        const rows = buildActionRows(messageKey);
        await interaction.update({ components: rows });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [, messageKey] = interaction.customId.split(':');
      if (interaction.customId.startsWith('comment_modal:')) {
        const text = interaction.fields.getTextInputValue('comment_text');

        if (!commentsStore.has(messageKey)) {
          commentsStore.set(messageKey, []);
        }
        commentsStore.get(messageKey).push({
          userId: interaction.user.id,
          username: interaction.member?.displayName || interaction.user.username,
          text,
          ts: Date.now(),
        });

        // تحديث نص رسالة الصورة نفسها ليضم التعليق الجديد — يظهر للجميع مباشرة
        try {
          const channel = interaction.channel;
          const targetMessage = await channel.messages.fetch(messageKey);
          await targetMessage.edit({
            content: buildMessageContent(messageKey),
            components: buildActionRows(messageKey),
          });
        } catch (e) {
          console.warn('تعذّر تحديث رسالة الصورة الأصلية:', e.message);
        }

        await interaction.reply({
          content: '✅ تم نشر تعليقك على الصورة.',
          ephemeral: true,
        });
      }
    }
  } catch (err) {
    console.error('خطأ أثناء معالجة التفاعل:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction
        .reply({ content: '⚠️ صار خطأ غير متوقع.', ephemeral: true })
        .catch(() => {});
    }
  }
});

// ================== تسجيل الدخول ==================
client.login(process.env.DISCORD_TOKEN);
