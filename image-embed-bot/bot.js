// ============================================================
//  بوت: تحويل الصور إلى Embed + أزرار تعليقات + تفاعلات
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
} = require('discord.js');

// -------------------- الإعدادات --------------------
const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL_ID = (process.env.TARGET_CHANNEL_ID || '').trim();
const REACTION_EMOJIS = (process.env.REACTION_EMOJIS || '👍,❤️,🔥,😂')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

const DATA_FILE = path.join(__dirname, 'comments.json');

// -------------------- تخزين التعليقات --------------------
// الشكل: { "messageId": [ { userId, username, text, timestamp }, ... ] }
function loadComments() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('خطأ بقراءة ملف التعليقات:', err);
    return {};
  }
}

function saveComments(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('خطأ بحفظ ملف التعليقات:', err);
  }
}

let commentsStore = loadComments();

function getComments(messageId) {
  return commentsStore[messageId] || [];
}

function addComment(messageId, comment) {
  if (!commentsStore[messageId]) commentsStore[messageId] = [];
  commentsStore[messageId].push(comment);
  saveComments(commentsStore);
  return commentsStore[messageId].length;
}

// -------------------- بناء المكوّنات (Embed + Buttons) --------------------
function buildButtons(messageId, commentCount) {
  const addBtn = new ButtonBuilder()
    .setCustomId(`add_comment:${messageId}`)
    .setLabel('إضافة تعليق')
    .setEmoji('➕')
    .setStyle(ButtonStyle.Secondary);

  const viewBtn = new ButtonBuilder()
    .setCustomId(`view_comments:${messageId}`)
    .setLabel(`عرض التعليقات (${commentCount})`)
    .setEmoji('💬')
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(addBtn, viewBtn);
}

function buildImageEmbed({ fileName, author }) {
  return new EmbedBuilder()
    .setColor(0xC4CED9) // رصاصي نيون
    .setAuthor({
      name: author.displayName || author.username,
      iconURL: author.displayAvatarURL ? author.displayAvatarURL() : undefined,
    })
    .setImage(`attachment://${fileName}`)
    .setTimestamp()
    .setFooter({ text: 'شارك رأيك بالصورة 👇' });
}

// -------------------- إنشاء العميل --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ البوت شغال باسم: ${c.user.tag}`);
});

// -------------------- استقبال الرسائل --------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (TARGET_CHANNEL_ID && message.channel.id !== TARGET_CHANNEL_ID) return;

    // نلقط أول مرفق يكون صورة
    const imageAttachment = message.attachments.find((att) =>
      (att.contentType || '').startsWith('image/')
    );
    if (!imageAttachment) return;

    // نحدد اسم ملف آمن ونحمّل الصورة كمرفق مستقل
    // (عشان لو حذفنا الرسالة الأصلية، الصورة تفضل شغالة لأنها صارت
    // مرفوعة بالرسالة الجديدة نفسها ومو مجرد رابط CDN تابع للقديمة)
    const safeName = (imageAttachment.name || 'image.png').replace(/\s+/g, '_');
    const attachmentFile = new AttachmentBuilder(imageAttachment.url, { name: safeName });

    const embed = buildImageEmbed({
      fileName: safeName,
      author: message.member ?? message.author,
    });

    // نرسل الإمبيد مع الصورة كمرفق أولاً عشان نحصل على الـ messageId
    const sent = await message.channel.send({ embeds: [embed], files: [attachmentFile] });

    const row = buildButtons(sent.id, 0);
    await sent.edit({ embeds: [embed], components: [row] });

    // نضيف الإيموجيات تلقائياً
    for (const emoji of REACTION_EMOJIS) {
      try {
        await sent.react(emoji);
      } catch (e) {
        console.error(`تعذر إضافة الإيموجي ${emoji}:`, e.message);
      }
    }

    // نحذف رسالة الصورة الأصلية
    if (message.deletable) {
      await message.delete().catch(() => {});
    }
  } catch (err) {
    console.error('خطأ بمعالجة رسالة الصورة:', err);
  }
});

// -------------------- استقبال تفاعلات الأزرار والنوافذ --------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // زر "إضافة تعليق" -> يفتح Modal
    if (interaction.isButton() && interaction.customId.startsWith('add_comment:')) {
      const messageId = interaction.customId.split(':')[1];

      const modal = new ModalBuilder()
        .setCustomId(`comment_modal:${messageId}`)
        .setTitle('إضافة تعليق');

      const input = new TextInputBuilder()
        .setCustomId('comment_text')
        .setLabel('اكتب تعليقك')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    // زر "عرض التعليقات"
    if (interaction.isButton() && interaction.customId.startsWith('view_comments:')) {
      const messageId = interaction.customId.split(':')[1];
      const comments = getComments(messageId);

      if (comments.length === 0) {
        await interaction.reply({
          content: 'ما فيه تعليقات على هذي الصورة لحد الحين. كن أول من يعلّق! ✍️',
          ephemeral: true,
        });
        return;
      }

      const list = comments
        .slice(-15) // آخر 15 تعليق تجنباً لتجاوز حد الرسالة
        .map((c, i) => `**${i + 1}. ${c.username}:** ${c.text}`)
        .join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`💬 التعليقات (${comments.length})`)
        .setDescription(list);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // استقبال نص التعليق من الـ Modal
    if (interaction.isModalSubmit() && interaction.customId.startsWith('comment_modal:')) {
      const messageId = interaction.customId.split(':')[1];
      const text = interaction.fields.getTextInputValue('comment_text').trim();

      if (!text) {
        await interaction.reply({ content: 'ما تقدر ترسل تعليق فاضي.', ephemeral: true });
        return;
      }

      const newCount = addComment(messageId, {
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
        text,
        timestamp: Date.now(),
      });

      // نحدّث عداد زر "عرض التعليقات" على الإمبيد الأصلي
      try {
        const channel = interaction.channel;
        const targetMessage = await channel.messages.fetch(messageId);
        const row = buildButtons(messageId, newCount);
        await targetMessage.edit({ components: [row] });
      } catch (e) {
        console.error('تعذر تحديث عداد التعليقات على الرسالة:', e.message);
      }

      await interaction.reply({ content: '✅ تم إضافة تعليقك بنجاح.', ephemeral: true });
      return;
    }
  } catch (err) {
    console.error('خطأ بمعالجة التفاعل:', err);
    if (interaction.isRepliable()) {
      await interaction
        .reply({ content: '⚠️ صار خطأ غير متوقع، حاول مرة ثانية.', ephemeral: true })
        .catch(() => {});
    }
  }
});

client.login(TOKEN);
