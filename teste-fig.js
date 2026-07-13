const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');

// =====================================
// CONFIGURAÇÕES
// =====================================
const TARGET_GROUP_NAME = 'os mídia de rec';  // Nome do seu grupo
const COMMAND = '!fig';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
    },
});

// =====================================
// FILA E PROCESSAMENTO
// =====================================
let isProcessing = false;
const queue = [];
const processedIds = new Set(); // Para evitar loops

async function createSticker(media) {
    try {
        if (media.mimetype.startsWith('image/')) {
            const img = Buffer.from(media.data, 'base64');
            const webp = await sharp(img)
                .resize(512, 512, { fit: 'cover' })
                .webp({ quality: 80 })
                .toBuffer();
            return { data: webp.toString('base64'), mimetype: 'image/webp' };
        } else if (media.mimetype.startsWith('video/')) {
            return media;
        }
    } catch (err) {
        console.error('Erro ao criar sticker:', err);
        throw err;
    }
}

async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const { quotedMsg, chat } = queue.shift();

    try {
        await chat.sendStateTyping();
        const media = await quotedMsg.downloadMedia();
        if (!media) throw new Error('Mídia não baixada');

        const sticker = await createSticker(media);
        await chat.sendMessage(sticker, { sendMediaAsSticker: true });
        console.log('✅ Figurinha enviada!');
    } catch (err) {
        console.error('❌ Erro:', err);
        await chat.sendMessage('❌ Erro ao criar figurinha.');
    } finally {
        isProcessing = false;
        if (queue.length > 0) setTimeout(processQueue, 1000);
    }
}

// =====================================
// EVENTO PRINCIPAL (USANDO message_create)
// =====================================
client.on('message_create', async (message) => {
    // Exibe TUDO que chega (inclusive as mensagens do próprio bot)
    console.log(`📩 Mensagem de ${message.from}: "${message.body || '[mídia]'}"`);

    const chat = await message.getChat();
    if (!chat.isGroup) {
        console.log('  ↳ Não é grupo');
        return;
    }

    console.log(`  ↳ Nome do grupo: "${chat.name}"`);

    // Comparação flexível
    const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalize(chat.name) !== normalize(TARGET_GROUP_NAME)) {
        console.log(`  ↳ Não é o grupo "${TARGET_GROUP_NAME}"`);
        return;
    }

    console.log('  ✅ Grupo correto!');

    // Verifica se é uma resposta
    if (!message.hasQuotedMsg) {
        console.log('  ↳ Não é resposta');
        return;
    }

    const quoted = await message.getQuotedMessage();
    if (!quoted.hasMedia) {
        console.log('  ↳ Mensagem citada não tem mídia');
        return;
    }

    const text = message.body?.trim() || '';
    if (text !== COMMAND) {
        console.log(`  ↳ Comando não é "${COMMAND}"`);
        return;
    }

    console.log('  ✅ Comando !fig detectado!');

    // Verifica o tipo da mídia
    const media = await quoted.downloadMedia();
    if (!media || (!media.mimetype.startsWith('image/') && !media.mimetype.startsWith('video/'))) {
        console.log('  ↳ Mídia não suportada');
        await chat.sendMessage('⚠️ Envie uma imagem ou vídeo/GIF.');
        return;
    }

    // 🛡️ VERIFICAÇÃO PARA EVITAR LOOP INFINITO:
    // Se a mensagem citada é uma figurinha (sticker) e foi enviada pelo próprio bot, ignoramos
    // Mas permitimos se for uma imagem normal (não sticker)
    if (quoted.fromMe) {
        // Tenta detectar se a mensagem citada é uma figurinha
        // Não temos uma forma 100% confiável, mas se a mensagem foi enviada pelo bot
        // e tem mídia, vamos verificar se o tipo é 'image/webp' (formato de sticker)
        // Infelizmente não temos acesso fácil ao tipo da mídia sem baixar, então vamos confiar que
        // o bot não vai responder a si mesmo se for uma figurinha.
        // SOLUÇÃO: Vamos permitir que o bot crie figurinhas a partir de imagens que ele enviou,
        // mas com um ID único para evitar loops.
        
        // Verifica se o ID da mensagem citada já foi processado
        if (processedIds.has(quoted.id.id)) {
            console.log('  ↳ Esta mensagem já foi processada. Ignorando para evitar loop.');
            return;
        }
        
        // Adiciona o ID à lista de processados
        processedIds.add(quoted.id.id);
        
        // Limita o tamanho do Set para não crescer infinitamente
        if (processedIds.size > 100) {
            const iterator = processedIds.values();
            for (let i = 0; i < 50; i++) {
                const next = iterator.next();
                if (next.done) break;
                processedIds.delete(next.value);
            }
        }
        
        console.log('  ↳ Mensagem do bot, mas permitindo processamento (com verificação de loop)');
    }

    queue.push({ quotedMsg: quoted, chat });
    console.log(`  📥 Adicionado à fila (${queue.length} itens)`);

    if (!isProcessing) processQueue();
});

// =====================================
// AUTENTICAÇÃO
// =====================================
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('🔑 Escaneie o QR Code');
});

client.on('ready', () => {
    console.log('✅ Bot conectado!');
    console.log(`👀 Monitorando o grupo: "${TARGET_GROUP_NAME}"`);
    console.log(`📸 Envie uma imagem e responda com ${COMMAND}`);
});

client.initialize();