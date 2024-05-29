import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import wppconnect from '@wppconnect-team/wppconnect';
import { initializeNewAIChatSession, mainOpenAI } from './service/openai';
import { splitMessages, sendMessagesWithDelay } from './util';
import { mainGoogle } from './service/google';

dotenv.config();
type AIOption = 'GPT' | 'GEMINI';

const messageBufferPerChatId = new Map();
const messageTimeouts = new Map();
const AI_SELECTED: AIOption = (process.env.AI_SELECTED as AIOption) || 'GEMINI';
const MAX_RETRIES = 3;

validateEnvironmentVariables();

const app = express();
let qrCodeData = '';

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Route to serve the QR code data
app.get('/qrcode', (req, res) => {
    res.json({ qrCodeData });
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendfile('./index.html');
});

// Start the Express server
startServer();

wppconnect
    .create({
        session: 'sessionName',
        catchQR: handleQRCode,
        statusFind: handleStatus,
        headless: 'new' as any,
    })
    .then((client) => {
        start(client);
    })
    .catch((error) => {
        console.error(error);
    });

function validateEnvironmentVariables(): void {
    if (AI_SELECTED === 'GEMINI' && !process.env.GEMINI_KEY) {
        throw Error(
            'Você precisa colocar uma key do Gemini no .env! Crie uma gratuitamente em https://aistudio.google.com/app/apikey?hl=pt-br'
        );
    }
    if (
        AI_SELECTED === 'GPT' &&
        (!process.env.OPENAI_KEY || !process.env.OPENAI_ASSISTANT)
    ) {
        throw Error(
            'Para utilizar o GPT você precisa colocar no .env a sua key da openai e o id do seu assistante.'
        );
    }
}

function startServer(): void {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

function handleQRCode(base64Qrimg: string, asciiQR: string, attempts: number, urlCode?: string): void {
    console.log('Terminal qrcode: ', asciiQR);
    qrCodeData = base64Qrimg;
}

function handleStatus(statusSession: string, session: string): void {
    console.log('Status Session: ', statusSession);
    console.log('Session name: ', session);
}

async function start(client: wppconnect.Whatsapp): Promise<void> {
    client.onMessage(handleMessage(client));
}

function handleMessage(client: wppconnect.Whatsapp) {
    return async (message: wppconnect.Message) => {
        if (isValidMessage(message)) {
            const chatId = message.chatId;
            console.log('Mensagem recebida:', message.body);

            if (AI_SELECTED === 'GPT') {
                await initializeNewAIChatSession(chatId);
            }

            updateMessageBuffer(chatId, message.body);
            handleMessageTimeout(client, chatId, message);
        }
    };
}

function isValidMessage(message: wppconnect.Message): boolean {
    return message.type === 'chat' && !message.isGroupMsg && message.chatId !== 'status@broadcast';
}

function updateMessageBuffer(chatId: string, messageBody: string): void {
    if (!messageBufferPerChatId.has(chatId)) {
        messageBufferPerChatId.set(chatId, [messageBody]);
    } else {
        messageBufferPerChatId.set(chatId, [
            ...messageBufferPerChatId.get(chatId),
            messageBody,
        ]);
    }
}

function handleMessageTimeout(client: wppconnect.Whatsapp, chatId: string, message: wppconnect.Message): void {
    if (messageTimeouts.has(chatId)) {
        clearTimeout(messageTimeouts.get(chatId));
    }

    console.log('Aguardando novas mensagens...');

    messageTimeouts.set(
        chatId,
        setTimeout(() => processMessages(client, chatId, message), 1000) //antes estava 15000 = 15 segundos.
    );
}

async function processMessages(client: wppconnect.Whatsapp, chatId: string, message: wppconnect.Message): Promise<void> {
    const currentMessage = !messageBufferPerChatId.has(chatId)
        ? message.body
        : [...messageBufferPerChatId.get(chatId)].join(' \n ');

    let answer = await getAnswer(currentMessage, chatId);

    const messages = splitMessages(answer);
    console.log('Enviando mensagens...');
    await sendMessagesWithDelay({
        client,
        messages,
        targetNumber: message.from,
    });

    messageBufferPerChatId.delete(chatId);
    messageTimeouts.delete(chatId);
}

async function getAnswer(currentMessage: string, chatId: string): Promise<string> {
    let answer = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (AI_SELECTED === 'GPT') {
                answer = await mainOpenAI({
                    currentMessage,
                    chatId,
                });
            } else {
                answer = await mainGoogle({
                    currentMessage,
                    chatId,
                });
            }
            break;
        } catch (error) {
            if (attempt === MAX_RETRIES) {
                throw error;
            }
        }
    }

    return answer;
}
