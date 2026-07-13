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

// Variável global para armazenar o QR Code (base64)
let latestQRCode = null;

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
    // EVENTO DE MENSAGEM (COM LOG EXTENSIVO)
    // =====================================
    // Usamos o evento 'message' porque é mais confiável em algumas versões
    client.on('message', async (message) => {
        // LOG DE TODAS AS MENSAGENS (IMPRESCINDÍVEL PARA DEPURAÇÃO)
        console.log('🔍 [MESSAGE EVENT] Mensagem recebida!');
        console.log(`  - De: ${message.from}`);
        console.log(`  - Corpo: "${message.body || '[mídia]'}"`);
        console.log(`  - Tem mídia? ${message.hasMedia}`);
        console.log(`  - É resposta? ${message.hasQuotedMsg}`);
        console.log(`  - Data: ${new Date().toISOString()}`);

        // Obtém o chat para verificar se é grupo
        const chat = await message.getChat();
        console.log(`  - É grupo? ${chat.isGroup}`);
        if (chat.isGroup) {
            console.log(`  - Nome do grupo: "${chat.name}"`);
            console.log(`  - ID do grupo: ${chat.id._serialized}`);
        }

        // Se não for grupo, ignora
        if (!chat.isGroup) {
            console.log('  ↳ Ignorando (não é grupo)');
            return;
        }

        // Verifica se o nome do grupo corresponde (com log para comparar)
        const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
        const detectedName = normalize(chat.name);
        const targetName = normalize(TARGET_GROUP_NAME);
        console.log(`  - Nome normalizado detectado: "${detectedName}"`);
        console.log(`  - Nome normalizado esperado: "${targetName}"`);

        if (detectedName !== targetName) {
            console.log(`  ↳ Ignorando (grupo não é "${TARGET_GROUP_NAME}")`);
            return;
        }

        console.log('  ✅ Grupo correto!');

        // Verifica se é resposta
        if (!message.hasQuotedMsg) {
            console.log('  ↳ Ignorando (não é resposta)');
            return;
        }

        const quoted = await message.getQuotedMessage();
        console.log(`  - Mensagem citada tem mídia? ${quoted.hasMedia}`);
        if (!quoted.hasMedia) {
            console.log('  ↳ Ignorando (mensagem citada não tem mídia)');
            return;
        }

        const text = message.body?.trim() || '';
        console.log(`  - Texto da mensagem: "${text}"`);
        if (text !== COMMAND) {
            console.log(`  ↳ Ignorando (comando não é "${COMMAND}")`);
            return;
        }

        console.log('  ✅ Comando !fig detectado!');

        // Baixa a mídia para verificar o tipo
        const media = await quoted.downloadMedia();
        if (!media) {
            console.log('  ↳ Falha ao baixar mídia');
            await chat.sendMessage('⚠️ Não foi possível baixar a mídia.');
            return;
        }

        console.log(`  - Tipo de mídia: ${media.mimetype}`);
        if (!media.mimetype.startsWith('image/') && !media.mimetype.startsWith('video/')) {
            console.log(`  ↳ Mídia não suportada: ${media.mimetype}`);
            await chat.sendMessage('⚠️ Envie uma imagem ou vídeo/GIF.');
            return;
        }

        // Evita loop com stickers do próprio bot
        if (quoted.fromMe && media.mimetype === 'image/webp') {
            console.log('  ↳ É sticker do próprio bot. Ignorando.');
            return;
        }

        const user = message.author || message.from;
        queue.push({ quotedMsg: quoted, chat, user });
        console.log(`  📥 Adicionado à fila (${queue.length} itens) - usuário: ${user}`);

        if (!isProcessing) processQueue();
    });

    // Também mantém o 'message_create' para garantir
    client.on('message_create', async (message) => {
        console.log('🔍 [MESSAGE_CREATE] Mensagem recebida!');
        // O mesmo código pode ser repetido ou podemos chamar uma função comum
        // Mas para simplificar, vamos apenas logar que o evento ocorreu
        // e depois chamar o mesmo handler se quiser
    });

    // =====================================
    // QR CODE E AUTENTICAÇÃO
    // =====================================
    client.on('qr', async (qr) => {
        console.log('🔑 QR Code gerado!');
        
        try {
            latestQRCode = await qrcode.toDataURL(qr, {
                type: 'image/png',
                width: 300,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });
            
            console.log('✅ QR Code pronto para escanear!');
            console.log('🌐 Acesse: https://' + (process.env.RENDER_EXTERNAL_HOSTNAME || 'seu-projeto') + '.onrender.com/');
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

// Rota principal
app.get('/', (req, res) => {
    if (latestQRCode) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bot Zap - Figurinhas</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; text-align: center; background: #f5f5f5; }
                    .card { background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    img { max-width: 100%; height: auto; border: 3px solid #ddd; border-radius: 8px; margin: 20px 0; }
                    .status { display: inline-block; padding: 8px 16px; border-radius: 20px; font-weight: bold; background: #4CAF50; color: #fff; }
                    code { background: #f0f0f0; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
                    hr { margin: 30px 0; border: 1px solid #eee; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>🤖 Bot Zap - Figurinhas</h1>
                    <p><strong>Status:</strong> <span class="status">✅ Conectado</span></p>
                    <p>Escaneie o QR Code abaixo para conectar o bot:</p>
                    <img src="${latestQRCode}" alt="QR Code">
                    <p><strong>📌 Como escanear:</strong></p>
                    <ol style="text-align: left; max-width: 400px; margin: 0 auto;">
                        <li>Abra o WhatsApp no celular</li>
                        <li>Vá em <strong>Configurações</strong> → <strong>Dispositivos vinculados</strong></li>
                        <li>Toque em <strong>Vincular um dispositivo</strong></li>
                        <li>Aponte a câmera para o QR Code acima</li>
                    </ol>
                    <hr>
                    <p><strong>Comando:</strong> Responda uma imagem com <code>!fig</code></p>
                    <p><strong>Grupo:</strong> os mídia de rec</p>
                </div>
                <script>
                    setTimeout(() => location.reload(), 30000);
                </script>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bot Zap - Figurinhas</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; text-align: center; background: #f5f5f5; }
                    .card { background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>🤖 Bot Zap - Figurinhas</h1>
                    <div class="spinner"></div>
                    <h2>Aguardando QR Code...</h2>
                    <p>Atualize a página se não aparecer em 1 minuto.</p>
                </div>
                <script>
                    setTimeout(() => location.reload(), 5000);
                </script>
            </body>
            </html>
        `);
    }
});

app.get('/status', (req, res) => {
    res.json({ status: 'online', connected: !!latestQRCode, queueSize: queue.length });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Servidor HTTP rodando na porta ${PORT}`);
    console.log(`🌐 Acesse: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'seu-projeto'}.onrender.com/`);
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
