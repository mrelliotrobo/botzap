const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const express = require('express');
const chromium = require('@sparticuz/chromium');

// =====================================
// CONFIGURAÇÕES
// =====================================
const TARGET_GROUP_NAME = 'os mídia de rec';
const COMMAND = '!fig';
const PORT = process.env.PORT || 10000;

// =====================================
// CONFIGURAÇÕES DE SEGURANÇA
// =====================================
const GLOBAL_DELAY_MS = 5000;
const PER_USER_DELAY_MS = 15000;
const PROCESS_DELAY_MIN = 4000;
const PROCESS_DELAY_MAX = 7000;
const MAX_QUEUE_SIZE = 50;

// =====================================
// FILA E PROCESSAMENTO
// =====================================
let isProcessing = false;
const queue = [];
const userLastUsed = new Map();

// =====================================
// FUNÇÃO PARA CRIAR O STICKER
// =====================================
async function createSticker(media) {
    try {
        console.log('🔧 Criando sticker...');
        console.log(`  - Tipo original: ${media.mimetype}`);

        let buffer;
        if (media.mimetype.startsWith('image/')) {
            buffer = Buffer.from(media.data, 'base64');
            console.log(`  - Tamanho original: ${buffer.length} bytes`);
        } else if (media.mimetype.startsWith('video/')) {
            console.log('  - Vídeo/GIF detectado, enviando como sticker animado');
            return new MessageMedia(media.mimetype, media.data);
        } else {
            throw new Error(`Tipo não suportado: ${media.mimetype}`);
        }

        const webpBuffer = await sharp(buffer)
            .resize(512, 512, {
                fit: 'cover',
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .webp({
                quality: 80,
                alphaQuality: 80,
                lossless: false,
                nearLossless: false,
                smartSubsample: true,
                effort: 4
            })
            .toBuffer();

        console.log(`  - Sticker gerado: ${webpBuffer.length} bytes`);

        const stickerMedia = new MessageMedia(
            'image/webp',
            webpBuffer.toString('base64')
        );
        stickerMedia.filename = 'sticker.webp';

        return stickerMedia;

    } catch (err) {
        console.error('❌ Erro no createSticker:', err);
        throw err;
    }
}

// =====================================
// PROCESSADOR DA FILA
// =====================================
async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const { quotedMsg, chat, user } = queue.shift();

    try {
        const now = Date.now();
        const lastUsed = userLastUsed.get(user) || 0;
        const timeSinceLast = now - lastUsed;
        if (timeSinceLast < PER_USER_DELAY_MS) {
            const waitTime = PER_USER_DELAY_MS - timeSinceLast;
            console.log(`⏳ Aguardando ${waitTime}ms para o usuário ${user}...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        userLastUsed.set(user, Date.now());

        const randomDelay = Math.floor(
            Math.random() * (PROCESS_DELAY_MAX - PROCESS_DELAY_MIN) + PROCESS_DELAY_MIN
        );
        console.log(`⏳ Processando com delay de ${randomDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));

        console.log('⬇️ Baixando mídia...');
        const media = await quotedMsg.downloadMedia();
        if (!media) throw new Error('Mídia não baixada');

        console.log('🎨 Convertendo para sticker...');
        const sticker = await createSticker(media);

        console.log('📤 Enviando sticker...');
        await chat.sendMessage(sticker, {
            sendMediaAsSticker: true,
            stickerAuthor: 'Bot Zap',
            stickerName: 'Figurinha'
        });

        console.log('✅ Sticker enviado com sucesso!');
    } catch (err) {
        console.error('❌ Erro no processamento:', err);
        await chat.sendMessage(`❌ Erro: ${err.message || 'falha ao criar sticker'}`);
    } finally {
        isProcessing = false;
        if (queue.length > 0) setTimeout(processQueue, 1000);
    }
}

// =====================================
// FUNÇÃO PARA INICIAR O BOT
// =====================================
async function startBot() {
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                ...chromium.args
            ],
            executablePath: await chromium.executablePath(),
        },
    });

    // =====================================
    // EVENTO PRINCIPAL
    // =====================================
    client.on('message_create', async (message) => {
        console.log(`📩 Mensagem de ${message.from}: "${message.body || '[mídia]'}"`);

        const chat = await message.getChat();
        if (!chat.isGroup) {
            console.log('  ↳ Não é grupo');
            return;
        }

        console.log(`  ↳ Nome do grupo: "${chat.name}"`);

        const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
        if (normalize(chat.name) !== normalize(TARGET_GROUP_NAME)) {
            console.log(`  ↳ Não é o grupo "${TARGET_GROUP_NAME}"`);
            return;
        }

        console.log('  ✅ Grupo correto!');

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

        const media = await quoted.downloadMedia();
        if (!media) {
            console.log('  ↳ Falha ao baixar mídia');
            await chat.sendMessage('⚠️ Não foi possível baixar a mídia.');
            return;
        }

        if (!media.mimetype.startsWith('image/') && !media.mimetype.startsWith('video/')) {
            console.log(`  ↳ Mídia não suportada: ${media.mimetype}`);
            await chat.sendMessage('⚠️ Envie uma imagem ou vídeo/GIF.');
            return;
        }

        if (quoted.fromMe && media.mimetype === 'image/webp') {
            console.log('  ↳ É sticker do próprio bot. Ignorando.');
            return;
        }

        const user = message.author || message.from;
        queue.push({ quotedMsg: quoted, chat, user });
        console.log(`  📥 Adicionado à fila (${queue.length} itens) - usuário: ${user}`);

        if (!isProcessing) processQueue();
    });

    // =====================================
    // QR CODE E AUTENTICAÇÃO
    // =====================================
    client.on('qr', async (qr) => {
        console.log('🔑 QR Code gerado!');

        try {
            const publicDir = path.join(__dirname, 'public');
            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
            }

            const qrPath = path.join(publicDir, 'qrcode.png');
            await qrcode.toFile(qrPath, qr, {
                type: 'png',
                width: 300,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });

            console.log(`📱 QR Code salvo em: ${qrPath}`);
            console.log(`🌐 Acesse: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'seu-projeto'}.onrender.com/qrcode.png para escanear`);
            console.log('📱 Ou acesse: Configurações do WhatsApp > Dispositivos vinculados > Vincular dispositivo');
        } catch (err) {
            console.error('❌ Erro ao gerar QR Code:', err);
        }
    });

    client.on('ready', () => {
        console.log('✅ Bot conectado e pronto!');
        console.log(`👀 Monitorando o grupo: "${TARGET_GROUP_NAME}"`);
        console.log(`📸 Envie uma imagem e responda com ${COMMAND}`);
    });

    client.on('authenticated', () => {
        console.log('🔐 Sessão autenticada.');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Falha na autenticação:', msg);
    });

    client.on('disconnected', (reason) => {
        console.log('🔌 Desconectado:', reason);
        console.log('🔄 Reinicie o bot para reconectar.');
    });

    // =====================================
    // INICIALIZA O BOT
    // =====================================
    await client.initialize();
    return client;
}

// =====================================
// SERVIDOR WEB (EXPRESS)
// =====================================
const app = express();

// Serve arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal - mostra uma página simples com o link do QR Code
app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 Bot Zap - Figurinhas</h1>
        <p>Para conectar o bot, escaneie o QR Code abaixo:</p>
        <img src="/qrcode.png" alt="QR Code" style="max-width: 300px;">
        <p>Ou acesse: <a href="/qrcode.png">/qrcode.png</a></p>
        <hr>
        <p><strong>Comando:</strong> Responda uma imagem com <code>!fig</code></p>
        <p><strong>Grupo:</strong> os mídia de rec</p>
    `);
});

// Inicia o servidor web
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor HTTP rodando na porta ${PORT}`);
    console.log(`🌐 Acesse: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'seu-projeto'}.onrender.com/ para escanear o QR Code`);
});

// =====================================
// INICIA O BOT
// =====================================
startBot().catch(err => {
    console.error('❌ Erro ao iniciar o bot:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('⚠️ Erro não tratado:', err);
});
