// بوت ديسكورد: يحوّل أي صورة يرسلها عضو إلى Embed ببطاقة فاتحة ناعمة (نيومورفيزم)
// التعليقات تظهر داخل نفس الـ Embed (وصف/Description) وتتحدث فورًا — تظهر للجميع، بدون رسالة تحت وبدون بوب-أب خاص
// بدون Thread — كل شيء داخل نفس الرسالة الواحدة.

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
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

const MAX_COMMENTS_SHOWN = 8; // كم تعليق تُعرض داخل الإيمبد قبل ما يصير طويل
const EMBED_COLOR = 0xe0e5ec; // لون البطاقة الفاتحة (نيومورفيزم)

// تخزين مؤقت بالذاكرة (يُستحسن استبداله بقاعدة بيانات لاحقًا)
const commentsStore = new Map(); // messageId -> [{ userId, username, text, ts }]
const reactionsStore = new Map(); // messageId -> Map(emoji -> Set(userId))
const authorStore = new Map(); // messageId -> { displayName, avatarURL }

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

// ================== بناء نص التعليقات داخل الإيمبد ==================
function buildCommentsDescription(messageKey) {
  const comments = commentsStore.get(messageKey) || [];
  if (comments.length === 0) return null;

  const shown = comments.slice(-MAX_COMMENTS_SHOWN);
  const hiddenCount = comments.length - shown.length;

  const lines = shown.map((c) => `**${c.username}:** ${c.text}`).join('\n');
  let title = `💬 التعليقات (${comments.length})`;
  if (hiddenCount > 0) title += ` — عرض آخر ${shown.length}`;

  return `${title}\n${lines}`;
}

// ================== بناء الإيمبد ==================
function buildEmbed(messageKey, imageRef) {
  const author = authorStore.get(messageKey) || { displayName: 'عضو', avatarURL: null };

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: author.displayName, iconURL: author.avatarURL || undefined })
    .setImage(imageRef)
    .setFooter({ text: '👇 شارك رأيك بالصورة' })
    .setTimestamp();

  const commentsText = buildCommentsDescription(messageKey);
  if (commentsText) embed.setDescription(commentsText);

  return embed;
}

// ================== بناء الأزرار ==================
function buildActionRows(messageKey) {
  const commentCount = (commentsStore.get(messageKey) || []).length;

  const commentRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_comment:${messageKey}`)
      .setLabel('➕ إضافة تعليق')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`view_comments:${messageKey}`)
      .setLabel(`💬 عرض التعليقات (${commentCount})`)
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

// ================== استقبال الصور وتحويلها لِـ Embed ==================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (TARGET_CHANNEL_ID && message.channelId !== TARGET_CHANNEL_ID) return;

  const imageAttachments = [...message.attachments.values()].filter((a) =>
    (a.contentType || '').startsWith('image/')
  );
  if (imageAttachments.length === 0) return;

  try {
    const displayName = message.member?.displayName || message.author.username;
    const avatarURL = message.author.displayAvatarURL();

    for (const attachment of imageAttachments) {
      const fileName = attachment.name || 'image.png';
      const file = new AttachmentBuilder(attachment.url, { name: fileName });
      const imageRef = `attachment://${fileName}`;

      // نرسل أول مرة بمعرف مؤقت لبناء الأزرار، ثم نحدّثها بعد ما نعرف الـ message.id الحقيقي
      const placeholderEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setAuthor({ name: displayName, iconURL: avatarURL })
        .setImage(imageRef);

      const sent = await message.channel.send({
        embeds: [placeholderEmbed],
        files: [file],
        components: [],
      });

      authorStore.set(sent.id, { displayName, avatarURL });
      const rows = buildActionRows(sent.id);
      const finalEmbed = buildEmbed(sent.id, imageRef);
      await sent.edit({ embeds: [finalEmbed], components: rows });
    }

    // حذف رسالة العضو الأصلية للحفاظ على القناة نظيفة (اختياري)
    if (message.deletable) {
      await message.delete().catch(() => {});
    }
  } catch (err) {
    console.error('خطأ أثناء تحويل الصورة إلى Embed:', err);
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

      if (action === 'view_comments') {
        const comments = commentsStore.get(messageKey) || [];
        if (comments.length === 0) {
          await interaction.reply({
            content: 'لا توجد تعليقات بعد. كن أول من يعلّق! ➕',
            ephemeral: true,
          });
          return;
        }
        const list = comments
          .map((c) => `**${c.username}:** ${c.text}`)
          .join('\n');
        await interaction.reply({
          content: `💬 كل التعليقات (${comments.length}):\n${list}`,
          ephemeral: true,
        });
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

        // تحديث الإيمبد نفسه ليضم التعليق الجديد — يظهر للجميع فورًا
        try {
          const channel = interaction.channel;
          const targetMessage = await channel.messages.fetch(messageKey);
          const existingImageAttachment = [...targetMessage.attachments.values()][0];
          const imageRef = existingImageAttachment
            ? `attachment://${existingImageAttachment.name}`
            : targetMessage.embeds[0]?.image?.url;

          const updatedEmbed = buildEmbed(messageKey, imageRef);
          await targetMessage.edit({
            embeds: [updatedEmbed],
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
